import "dotenv/config";

Object.assign(process.env, {
  NODE_ENV: "test",
  DEMO_MODE: "true",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://research:research@localhost:55432/research_workbench_test"
});
