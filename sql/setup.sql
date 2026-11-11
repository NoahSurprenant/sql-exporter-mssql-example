-- Run as sa with sqlcmd, passing the exporter's password:
--   sqlcmd -S localhost -U sa -P <sa password> -C -b -i sql/setup.sql -v EXPORTER_PASSWORD=<password>
--
-- Creates the exporter's own login and a small example database for the workload to use.

-- The exporter's login: server-level read access to the DMVs and catalog metadata, and no user in
-- any database. VIEW SERVER STATE and VIEW ANY DEFINITION are what mssql_standard documents;
-- mssql_query_stats and mssql_missing_indexes need only VIEW SERVER STATE.
IF SUSER_ID(N'sql_exporter') IS NULL
    CREATE LOGIN sql_exporter WITH PASSWORD = N'$(EXPORTER_PASSWORD)', CHECK_POLICY = OFF;
GO
GRANT VIEW SERVER STATE TO sql_exporter;
GRANT VIEW ANY DEFINITION TO sql_exporter;
-- Names of objects inside the databases (mssql_procedure_stats): VIEW ANY DEFINITION alone makes
-- them visible but doesn't let the login into a database it has no user in, so OBJECT_NAME()
-- returns NULL. CONNECT ANY DATABASE lets it in, still without reading any table's data.
GRANT CONNECT ANY DATABASE TO sql_exporter;
GO

-- The OpenTelemetry Collector's login (sql_server receiver), the same password for simplicity. The
-- receiver also needs VIEW ANY DATABASE (granted to public by default, made explicit here), and
-- VIEW ANY DEFINITION and CONNECT ANY DATABASE to name procedures in db.server.top_procedure.
IF SUSER_ID(N'otel_collector') IS NULL
    CREATE LOGIN otel_collector WITH PASSWORD = N'$(EXPORTER_PASSWORD)', CHECK_POLICY = OFF;
GO
GRANT VIEW SERVER STATE TO otel_collector;
GRANT VIEW ANY DEFINITION TO otel_collector;
GRANT VIEW ANY DATABASE TO otel_collector;
GRANT CONNECT ANY DATABASE TO otel_collector;
GO

IF DB_ID(N'ExampleShop') IS NULL
    CREATE DATABASE ExampleShop;
GO
USE ExampleShop;
GO
IF OBJECT_ID(N'dbo.Customers') IS NULL
BEGIN
    CREATE TABLE dbo.Customers (
        Id int IDENTITY PRIMARY KEY,
        Name nvarchar(100) NOT NULL,
        Region nvarchar(20) NOT NULL
    );
    CREATE TABLE dbo.Orders (
        Id int IDENTITY PRIMARY KEY,
        CustomerId int NOT NULL REFERENCES dbo.Customers (Id),
        Total decimal(10, 2) NOT NULL,
        PlacedAt datetime2 NOT NULL
    );
    CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId);
END
GO
IF NOT EXISTS (SELECT 1 FROM dbo.Customers)
BEGIN
    -- 1,000 customers and 20,000 orders: enough for the plan cache to show real reads.
    WITH n AS (
        SELECT TOP (1000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT dbo.Customers (Name, Region)
    SELECT CONCAT(N'Customer ', i), CHOOSE(i % 4 + 1, N'North', N'South', N'East', N'West') FROM n;

    WITH n AS (
        SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
        FROM sys.all_objects a CROSS JOIN sys.all_objects b
    )
    INSERT dbo.Orders (CustomerId, Total, PlacedAt)
    SELECT i % 1000 + 1, (i % 500) + 0.99, DATEADD(minute, -i, SYSUTCDATETIME()) FROM n;
END
GO

-- Stored procedures for the workload, which mssql_procedure_stats reports on. OrdersAtTotal filters
-- on a column with no index, so SQL Server records a missing-index suggestion for it
-- (mssql_missing_indexes).
CREATE OR ALTER PROCEDURE dbo.CustomerOrders @customer int AS
    SELECT o.Id, o.Total, o.PlacedAt FROM dbo.Orders AS o WHERE o.CustomerId = @customer ORDER BY o.PlacedAt DESC;
GO
CREATE OR ALTER PROCEDURE dbo.OrdersAtTotal @total decimal(10, 2) AS
    SELECT o.Id, o.CustomerId, o.PlacedAt FROM dbo.Orders AS o WHERE o.Total = @total;
GO
CREATE OR ALTER PROCEDURE dbo.RegionRevenue @region nvarchar(20) AS
    SELECT c.Region, COUNT(*) AS Orders, SUM(o.Total) AS Revenue
    FROM dbo.Customers AS c JOIN dbo.Orders AS o ON o.CustomerId = c.Id
    WHERE c.Region = @region
    GROUP BY c.Region;
GO

-- A varchar column looked up with an nvarchar parameter: SQL Server has to convert every row's
-- value, so the index on Code can't be sought and the plan carries a PlanAffectingConvert warning
-- (the plan-warnings panel). A classic ORM mistake, made on purpose.
IF COL_LENGTH(N'dbo.Customers', N'Code') IS NULL
    ALTER TABLE dbo.Customers ADD Code varchar(20) NULL;
GO
UPDATE dbo.Customers SET Code = CONCAT('C', RIGHT(CONCAT('0000', Id), 5)) WHERE Code IS NULL;
IF INDEXPROPERTY(OBJECT_ID(N'dbo.Customers'), N'IX_Customers_Code', N'IndexID') IS NULL
    CREATE INDEX IX_Customers_Code ON dbo.Customers (Code);
GO
CREATE OR ALTER PROCEDURE dbo.CustomerByCode @code nvarchar(20) AS
    SELECT c.Id, c.Name, c.Region FROM dbo.Customers AS c WHERE c.Code = @code;
GO

-- An index nothing reads but every insert into Orders has to maintain (mssql_index_usage).
IF INDEXPROPERTY(OBJECT_ID(N'dbo.Orders'), N'IX_Orders_PlacedAt', N'IndexID') IS NULL
    CREATE INDEX IX_Orders_PlacedAt ON dbo.Orders (PlacedAt);
GO

-- A full backup to the server's default backup directory, so the backup-age panel has one database
-- that was backed up and the system databases that weren't.
BACKUP DATABASE ExampleShop TO DISK = N'ExampleShop.bak' WITH INIT, COPY_ONLY;
GO

-- Backup history lives in msdb, which the exporter reads as a user with only SELECT on it.
USE msdb;
GO
IF USER_ID(N'sql_exporter') IS NULL
    CREATE USER sql_exporter FOR LOGIN sql_exporter;
GRANT SELECT ON dbo.backupset TO sql_exporter;
GO
