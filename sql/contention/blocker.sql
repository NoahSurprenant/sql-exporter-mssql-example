-- Holds a lock on customer 1 for 20 seconds; blocked.sql waits on it (run.sh / run.ps1).
SET NOCOUNT ON;
USE ExampleShop;
BEGIN TRANSACTION;
UPDATE dbo.Customers SET Name = CONCAT(Name, N'.') WHERE Id = 1;
WAITFOR DELAY '00:00:20';
ROLLBACK;
