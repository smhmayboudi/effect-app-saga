# Docker Setup for effect-app-saga

This project includes a Docker Compose configuration to easily set up a PostgreSQL database for your effect-app-saga application.

## Prerequisites

- Docker Desktop installed and running
- Docker Compose plugin installed (included with Docker Desktop)

## Setting Up the Database

1. Make sure Docker is running on your machine.

2. Start the PostgreSQL service:
   ```bash
   docker compose up -d
   ```

3. Verify the service is running:
   ```bash
   docker compose ps
   ```

4. To stop the service:
   ```bash
   docker compose down
   ```

## Database Configuration

The database is configured with the following settings:
- Database name: `effect_pg_dev`
- Username: `postgres`
- Password: `password`
- Port: `5432` (mapped to localhost)

The .env file contains the necessary connection strings and configuration values for your application to connect to the database.

## Troubleshooting

If you encounter issues:
1. Ensure Docker is running
2. Check that the port 5432 is not already in use
3. Verify you have sufficient disk space for the database volume

## Persistence

Database data is persisted using a named volume (`postgres_data`), which will survive container restarts. To completely remove the data, you can run:
```bash
docker compose down -v
```