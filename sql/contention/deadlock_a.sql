-- Customer 2, then order 2; deadlock_b.sql takes them the other way round, so one of the two is
-- chosen as the deadlock victim (error 1205) and system_health records the deadlock graph.
SET NOCOUNT ON;
USE ExampleShop;
BEGIN TRANSACTION;
UPDATE dbo.Customers SET Name = CONCAT(Name, N'.') WHERE Id = 2;
WAITFOR DELAY '00:00:03';
UPDATE dbo.Orders SET Total = Total + 1 WHERE Id = 2;
ROLLBACK;
