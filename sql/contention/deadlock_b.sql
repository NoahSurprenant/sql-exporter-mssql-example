-- See deadlock_a.sql: the same two rows in the opposite order.
SET NOCOUNT ON;
USE ExampleShop;
BEGIN TRANSACTION;
UPDATE dbo.Orders SET Total = Total + 1 WHERE Id = 2;
WAITFOR DELAY '00:00:03';
UPDATE dbo.Customers SET Name = CONCAT(Name, N'.') WHERE Id = 2;
ROLLBACK;
