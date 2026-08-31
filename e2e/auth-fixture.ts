import path from "node:path";

export const E2E_AUTH_STORAGE_STATE = path.join(
  process.cwd(),
  ".artifacts",
  "e2e-auth-storage.json"
);

export const E2E_NORMAL_OPERATOR = {
  username: "e2e-workflow-operator",
  displayName: "E2E workflow operator",
  password: "correct browser workflow fixture"
} as const;

export const E2E_AUTH_OPERATOR = {
  username: "e2e-auth-operator",
  displayName: "E2E auth operator",
  password: "correct browser auth fixture"
} as const;

export const E2E_OPERATOR_USERNAMES = [
  E2E_NORMAL_OPERATOR.username,
  E2E_AUTH_OPERATOR.username
] as const;

export const E2E_OPERATOR_LABELS = [
  E2E_NORMAL_OPERATOR.displayName,
  E2E_AUTH_OPERATOR.displayName
] as const;
