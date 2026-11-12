-- SQL Server Agent jobs for the agent panel (mssql_agent): one that succeeds and one that fails,
-- each scheduled every minute. Run as sa after setup.sql, without sqlcmd -b:
--   sqlcmd -S localhost -U sa -P <sa password> -C -i sql/agent.sql
-- Agent must be running (MSSQL_AGENT_ENABLED in compose.yaml; the SQLSERVERAGENT service on
-- Windows). The script waits up to two minutes for it to finish starting (while it starts, msdb
-- refuses job changes: "Cannot perform this operation while SQLServerAgent is starting"), creates
-- the jobs, starts both and waits for them to finish, so their outcomes are in history before the
-- checks run.
USE msdb;
GO
SET NOCOUNT ON;
DECLARE @i int = 0, @ready bit = 0;
WHILE @ready = 0 AND @i < 120
BEGIN
    IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE program_name LIKE N'SQLAgent%')
    BEGIN
        BEGIN TRY
            EXEC msdb.dbo.sp_is_sqlagent_starting;  -- raises 14258 while Agent is still starting
            SET @ready = 1;
        END TRY
        BEGIN CATCH
        END CATCH;
    END
    IF @ready = 0 BEGIN WAITFOR DELAY '00:00:01'; SET @i += 1; END
END
IF @ready = 0
    PRINT 'SQL Server Agent is not running: the jobs run on their schedule once it is.';
GO
SET NOCOUNT ON;
DECLARE @jobs TABLE (name sysname, command nvarchar(400), description nvarchar(400));
INSERT @jobs VALUES
    (N'ExampleShop - refresh totals', N'SELECT COUNT(*) FROM dbo.Orders;', N'Succeeds.'),
    (N'ExampleShop - import feed', N'RAISERROR(N''The feed file is missing.'', 16, 1);', N'Fails, for the failing-jobs panel.');
DECLARE @name sysname, @command nvarchar(400), @description nvarchar(400);
DECLARE j CURSOR LOCAL FAST_FORWARD FOR SELECT name, command, description FROM @jobs;
OPEN j;
FETCH NEXT FROM j INTO @name, @command, @description;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.sysjobs WHERE name = @name)
    BEGIN
        EXEC dbo.sp_add_job @job_name = @name, @description = @description;
        EXEC dbo.sp_add_jobstep @job_name = @name, @step_name = N'run', @subsystem = N'TSQL',
            @database_name = N'ExampleShop', @command = @command;
        EXEC dbo.sp_add_jobschedule @job_name = @name, @name = N'every minute',
            @freq_type = 4, @freq_interval = 1, @freq_subday_type = 4, @freq_subday_interval = 1;
        EXEC dbo.sp_add_jobserver @job_name = @name;
    END
    FETCH NEXT FROM j INTO @name, @command, @description;
END
GO

SET NOCOUNT ON;
DECLARE @i int = 0;
IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE program_name LIKE N'SQLAgent%')
BEGIN
    -- Already running from its schedule is fine.
    BEGIN TRY EXEC msdb.dbo.sp_start_job @job_name = N'ExampleShop - refresh totals'; END TRY BEGIN CATCH END CATCH;
    BEGIN TRY EXEC msdb.dbo.sp_start_job @job_name = N'ExampleShop - import feed'; END TRY BEGIN CATCH END CATCH;
    SET @i = 0;
    WHILE (SELECT COUNT(DISTINCT h.job_id) FROM msdb.dbo.sysjobhistory AS h
           JOIN msdb.dbo.sysjobs AS j ON j.job_id = h.job_id
           WHERE h.step_id = 0 AND j.name LIKE N'ExampleShop - %') < 2 AND @i < 60
    BEGIN
        WAITFOR DELAY '00:00:01';
        SET @i += 1;
    END
END
GO
