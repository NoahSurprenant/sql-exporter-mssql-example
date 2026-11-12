-- SQL Server Agent jobs for the agent panel (mssql_agent): one that succeeds and one that fails,
-- each scheduled every minute. Run as sa after setup.sql, without sqlcmd -b:
--   sqlcmd -S localhost -U sa -P <sa password> -C -i sql/agent.sql
-- Agent must be running (MSSQL_AGENT_ENABLED in compose.yaml; the SQLSERVERAGENT service on
-- Windows). While it is still starting, msdb refuses job changes ("Cannot perform this operation
-- while SQL Server Agent is starting", 14258), so each job is created in its own transaction and
-- retried for up to two minutes. Then both are started and awaited, so their outcomes are in
-- history before the checks run.
USE msdb;
GO
CREATE PROCEDURE #add_job @name sysname, @command nvarchar(400), @description nvarchar(400) AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @try int = 0;
    WHILE NOT EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = @name) AND @try < 60
    BEGIN
        BEGIN TRY
            BEGIN TRANSACTION;
            EXEC msdb.dbo.sp_add_job @job_name = @name, @description = @description;
            EXEC msdb.dbo.sp_add_jobstep @job_name = @name, @step_name = N'run', @subsystem = N'TSQL',
                @database_name = N'ExampleShop', @command = @command;
            EXEC msdb.dbo.sp_add_jobschedule @job_name = @name, @name = N'every minute',
                @freq_type = 4, @freq_interval = 1, @freq_subday_type = 4, @freq_subday_interval = 1;
            EXEC msdb.dbo.sp_add_jobserver @job_name = @name;
            COMMIT;
        END TRY
        BEGIN CATCH
            IF @@TRANCOUNT > 0 ROLLBACK;
            SET @try += 1;
            WAITFOR DELAY '00:00:02';
        END CATCH;
    END
    IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = @name)
        PRINT CONCAT(N'Could not create the job ', @name, N': is SQL Server Agent running?');
END
GO
EXEC #add_job N'ExampleShop - refresh totals', N'SELECT COUNT(*) FROM dbo.Orders;', N'Succeeds.';
EXEC #add_job N'ExampleShop - import feed', N'RAISERROR(N''The feed file is missing.'', 16, 1);', N'Fails, for the failing-jobs panel.';
GO

SET NOCOUNT ON;
DECLARE @i int = 0;
IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE program_name LIKE N'SQLAgent%')
BEGIN
    -- Already running from its schedule is fine.
    BEGIN TRY EXEC msdb.dbo.sp_start_job @job_name = N'ExampleShop - refresh totals'; END TRY BEGIN CATCH END CATCH;
    BEGIN TRY EXEC msdb.dbo.sp_start_job @job_name = N'ExampleShop - import feed'; END TRY BEGIN CATCH END CATCH;
    WHILE (SELECT COUNT(DISTINCT h.job_id) FROM msdb.dbo.sysjobhistory AS h
           JOIN msdb.dbo.sysjobs AS j ON j.job_id = h.job_id
           WHERE h.step_id = 0 AND j.name LIKE N'ExampleShop - %') < 2 AND @i < 90
    BEGIN
        WAITFOR DELAY '00:00:01';
        SET @i += 1;
    END
END
ELSE
    PRINT 'SQL Server Agent is not running: the jobs run on their schedule once it is.';
GO
