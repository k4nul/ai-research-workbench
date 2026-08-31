import "dotenv/config";

Object.assign(process.env, {
  NODE_ENV: "test",
  DEMO_MODE: "true",
  AUTH_ENABLED: "true",
  AUTH_DEMO_BYPASS: "true",
  APP_URL: "http://localhost:3100",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://research:research@localhost:55432/research_workbench_test"
});
