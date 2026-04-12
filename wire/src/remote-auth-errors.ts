export const RemoteAuthErrorCode = {
  accountNotFound: "remote_account_not_found",
  accountMismatch: "remote_account_mismatch",
  setupTokensMissing: "remote_setup_tokens_missing",
  setupTokenInvalid: "remote_setup_token_invalid",
  loginAlreadyBound: "remote_login_already_bound",
  machineAlreadyBound: "remote_machine_already_bound",
  invalidLogin: "remote_invalid_login",
  invalidRegister: "remote_invalid_register",
  invalidLoginState: "remote_invalid_login_state",
  adminPasswordInvalid: "remote_admin_password_invalid",
  authUpgradeRequired: "remote_auth_upgrade_required",
} as const;

export type RemoteAuthErrorCode =
  (typeof RemoteAuthErrorCode)[keyof typeof RemoteAuthErrorCode];

export type RemoteAuthHintContext = "cli" | "browser" | "admin";

const REMOTE_AUTH_ERROR_CODE_SET = new Set<string>(
  Object.values(RemoteAuthErrorCode),
);

export function isRemoteAuthErrorCode(
  value: unknown,
): value is RemoteAuthErrorCode {
  return typeof value === "string" && REMOTE_AUTH_ERROR_CODE_SET.has(value);
}

export function getRemoteAuthHint(params: {
  code?: string | null;
  error?: string | null;
  context: RemoteAuthHintContext;
}): string {
  const code = isRemoteAuthErrorCode(params.code) ? params.code : null;
  if (code === RemoteAuthErrorCode.invalidLogin) {
    if (params.context === "cli") {
      return "Remote password is incorrect for this registered CLI account. Update --remote-password (or CODEXDECK_REMOTE_PASSWORD) to match the target server credentials.";
    }
    if (params.context === "admin") {
      return "Admin password is incorrect.";
    }
    return "Incorrect password for this remote username. Use the same password configured on the target CLI.";
  }
  if (code === RemoteAuthErrorCode.accountNotFound) {
    if (params.context === "cli") {
      return "Remote account not found. Register this CLI first using a valid --remote-setup-token, --remote-username, and --remote-password.";
    }
    return "Remote account not found. Start the CLI first with --remote-setup-token, --remote-username, and --remote-password.";
  }
  if (code === RemoteAuthErrorCode.accountMismatch) {
    return "This login is bound to a different machine. Use the credentials originally registered for this machine, or configure a different --remote-machine-id.";
  }
  if (code === RemoteAuthErrorCode.setupTokenInvalid) {
    return "Setup token is invalid or disabled. Generate a valid setup token in the server admin page and retry.";
  }
  if (code === RemoteAuthErrorCode.setupTokensMissing) {
    return "Remote server has no setup tokens configured. Add setup tokens in server admin before registering a CLI.";
  }
  if (code === RemoteAuthErrorCode.invalidLoginState) {
    return "Remote login attempt expired or is no longer valid. Retry login.";
  }
  if (code === RemoteAuthErrorCode.invalidRegister) {
    return "Remote registration attempt expired or is no longer valid. Retry CLI registration.";
  }
  if (
    code === RemoteAuthErrorCode.loginAlreadyBound ||
    code === RemoteAuthErrorCode.machineAlreadyBound
  ) {
    return "This remote login or machine is already bound to different credentials. Verify --remote-username, --remote-password, and --remote-machine-id.";
  }
  if (code === RemoteAuthErrorCode.authUpgradeRequired) {
    return "Legacy remote auth is no longer supported. Re-register this CLI using the current codex-deck version.";
  }
  if (code === RemoteAuthErrorCode.adminPasswordInvalid) {
    return "Admin password is incorrect.";
  }

  const fallback = params.error?.trim();
  if (fallback) {
    return fallback;
  }
  if (params.context === "admin") {
    return "Remote admin login failed.";
  }
  return "Remote login failed.";
}
