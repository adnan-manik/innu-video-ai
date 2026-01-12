import {Pool} from 'pg';
import 'dotenv/config';

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || "innu_db",
  user: process.env.DB_USER || "dbadmin",
  password: process.env.DB_PASSWORD || "",
  ssl:
    process.env.DB_SSL === "true"
      ? {
          rejectUnauthorized: false, 
        }
      : false,
});

export default {
  query: (text, params) => pool.query(text, params),
};