import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// 禁用预编译语句以避免 prepared statement 冲突
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
