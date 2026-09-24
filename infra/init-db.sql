\getenv app_password APP_DB_PASSWORD
SELECT format('CREATE ROLE ijara_app LOGIN PASSWORD %L', :'app_password') \gexec
GRANT CONNECT ON DATABASE ijara360 TO ijara_app;
