-- A little traffic for the exporter to report on, standing in for an application. Run as sa after
-- setup.sql:
--   sqlcmd -S localhost -U sa -P <sa password> -C -i sql/workload.sql
-- Not run with -b: the last batch fails on purpose.
USE ExampleShop;
GO

-- Parameterized statements, as an ORM sends them: one plan-cache entry (one query_hash) each,
-- however many times they run. These are what mssql_query_executions_total and friends count.
DECLARE @i int = 0, @customer int, @region nvarchar(20);
WHILE @i < 200
BEGIN
    SET @customer = @i % 1000 + 1;
    SET @region = CHOOSE(@i % 4 + 1, N'North', N'South', N'East', N'West');

    EXEC sp_executesql
        N'SELECT o.Id, o.Total, o.PlacedAt FROM dbo.Orders AS o WHERE o.CustomerId = @customer ORDER BY o.PlacedAt DESC',
        N'@customer int', @customer = @customer;

    EXEC sp_executesql
        N'SELECT c.Region, COUNT(*) AS Orders, SUM(o.Total) AS Revenue FROM dbo.Customers AS c JOIN dbo.Orders AS o ON o.CustomerId = c.Id WHERE c.Region = @region GROUP BY c.Region',
        N'@region nvarchar(20)', @region = @region;

    EXEC sp_executesql
        N'INSERT dbo.Orders (CustomerId, Total, PlacedAt) VALUES (@customer, 9.99, SYSUTCDATETIME())',
        N'@customer int', @customer = @customer;

    SET @i += 1;
END
GO

-- The stored procedures: 50 calls each.
DECLARE @j int = 0;
WHILE @j < 50
BEGIN
    DECLARE @c int = @j * 7 % 1000 + 1, @t decimal(10, 2) = @j % 500 + 0.99,
        @r nvarchar(20) = CHOOSE(@j % 4 + 1, N'North', N'South', N'East', N'West');
    EXEC dbo.CustomerOrders @customer = @c;
    EXEC dbo.OrdersAtTotal @total = @t;
    EXEC dbo.RegionRevenue @region = @r;
    -- An nvarchar code against the varchar column: the implicit-conversion plan warning.
    DECLARE @code nvarchar(20) = CONCAT(N'C', RIGHT(CONCAT(N'0000', @c), 5));
    EXEC dbo.CustomerByCode @code = @code;
    SET @j += 1;
END
GO

-- A full scan, so one statement stands out by reads.
SELECT COUNT(*) AS LargeOrders FROM dbo.Orders WHERE Total * 2 > 900;
GO

-- A user error, which mssql_user_errors counts.
SELECT 1 / 0;
GO
