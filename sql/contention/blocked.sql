-- Reads customer 1 while blocker.sql holds it: blocked for the rest of its 20 seconds.
SET NOCOUNT ON;
USE ExampleShop;
SELECT Name FROM dbo.Customers WHERE Id = 1;
