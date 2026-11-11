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

-- A full scan, so one statement stands out by reads.
SELECT COUNT(*) AS LargeOrders FROM dbo.Orders WHERE Total * 2 > 900;
GO

-- A user error, which mssql_user_errors counts.
SELECT 1 / 0;
GO
