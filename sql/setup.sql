-- Run as sa with sqlcmd, passing the exporter's password:
--   sqlcmd -S localhost -U sa -P <sa password> -C -b -i sql/setup.sql -v EXPORTER_PASSWORD=<password>
--
-- Creates the exporter's own login and a small example database for the workload to use.

-- The exporter's login: server-level read access to the DMVs and catalog metadata, and no user in
-- any database. These are the two permissions mssql_standard documents; mssql_query_stats needs
-- only VIEW SERVER STATE.
IF SUSER_ID(N'sql_exporter') IS NULL
    CREATE LOGIN sql_exporter WITH PASSWORD = N'$(EXPORTER_PASSWORD)', CHECK_POLICY = OFF;
GO
GRANT VIEW SERVER STATE TO sql_exporter;
GRANT VIEW ANY DEFINITION TO sql_exporter;
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
