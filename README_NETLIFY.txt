BLOOD BANK MANAGEMENT — NETLIFY VERSION

This package keeps the original dashboard HTML and replaces the Python/SQLite server
with a Netlify Function (Node.js) and a PostgreSQL database.

BEFORE DEPLOYING
1. Create a free PostgreSQL database with Neon (or another PostgreSQL provider).
2. Copy its connection string (DATABASE_URL).
3. Deploy this folder/repository to Netlify.
4. In Netlify: Site configuration > Environment variables, add:
   DATABASE_URL = your PostgreSQL connection string
   SESSION_SECRET = a long random secret (at least 32 random characters)
5. Trigger a new deploy.

GITHUB / NETLIFY
- Upload the CONTENTS of this folder to the root of a GitHub repository.
- Netlify build command: npm install
- Publish directory: public
- Functions directory: netlify/functions
- Or connect the GitHub repository and let netlify.toml supply publish/functions settings.

NOTES
- The database schema and sample records are created automatically on first API request.
- The sample records mirror the original project: unit 1001 and request 101.
- Real donor/patient information should not be used in a public demo database.
- This is a student project prototype, not a clinical blood-bank system. Blood compatibility
  and transfusion decisions must be verified by qualified medical staff.
- This package requires a PostgreSQL database. Netlify does not run the original Python
  server.py or provide durable SQLite storage for this app.
