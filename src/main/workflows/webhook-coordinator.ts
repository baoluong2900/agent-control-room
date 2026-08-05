import type { WebContents } from "electron";
import type { WebhookListenerStatus } from "./webhook-listener";
import { WebhookListenerService, generateWebhookToken } from "./webhook-listener";
import type { WorkflowSchedulerService } from "./workflow-scheduler";
import type { DesktopDatabase } from "../database/desktop-database";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";

/** Where the vault reference for the webhook token is remembered between launches. */
const TOKEN_REFERENCE_KEY = "webhook.token.reference";

/**
 * Owns the webhook listener's lifecycle and its local token.
 *
 * Split from the listener itself so the listener stays a plain HTTP server with no
 * knowledge of the database, the vault, or workflow state — which is what lets the
 * tests drive it over real HTTP without standing up the app.
 *
 * The rule this enforces: **the port is only open while an active webhook workflow
 * exists.** A user who never configures a webhook never has a listening socket, so
 * the feature costs nothing until it is asked for.
 */
export class WebhookCoordinator {
  private listener: WebhookListenerService | null = null;
  private token: string | null = null;

  constructor(
    private readonly database: DesktopDatabase,
    private readonly vault: ProviderSecretVault,
    private readonly scheduler: WorkflowSchedulerService,
    private readonly webContentsProvider: () => WebContents | null,
    /** Fixed port for tests; production lets the OS assign one. */
    private readonly port?: number,
  ) {}

  /**
   * Starts the listener when a webhook workflow needs it, stops it when none do.
   *
   * Safe to call repeatedly — the scheduler calls it on every tick so that enabling
   * or deleting a webhook workflow takes effect without an app restart.
   */
  async sync(): Promise<WebhookListenerStatus> {
    const needed = this.scheduler.hasActiveWebhookWorkflows();

    if (!needed) {
      await this.stop();
      return { running: false, port: null, baseUrl: null, error: null };
    }

    if (this.listener) return this.listener.status();

    const listener = new WebhookListenerService({
      port: this.port,
      token: this.ensureToken(),
      onDelivery: async (delivery) => ({
        fired: await this.scheduler.runWebhookWorkflows(delivery.hook, delivery.payload, delivery.receivedAt),
      }),
      onError: (message) => this.log(message),
    });

    const status = await listener.start();
    // Only retain the listener when it actually bound. Keeping a failed one would
    // make `sync` believe the port is open and never retry.
    this.listener = status.running ? listener : null;
    if (status.running) {
      this.log(`🔌 Webhook listener ready at ${status.baseUrl}/<name> (loopback only, token required)`);
    }
    return status;
  }

  async stop(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    if (listener) await listener.stop();
  }

  status(): WebhookListenerStatus {
    return this.listener?.status() ?? { running: false, port: null, baseUrl: null, error: null };
  }

  /** The token callers must present. Generated once, then reused across launches. */
  ensureToken(): string {
    if (this.token) return this.token;

    const existingReference = this.database.getSetting(TOKEN_REFERENCE_KEY);
    if (existingReference) {
      try {
        const stored = this.vault.read(existingReference);
        if (stored) {
          this.token = stored;
          return stored;
        }
      } catch {
        // An unreadable vault (locked OS keychain session) must not stop the app
        // from working; a fresh token is generated below instead.
      }
    }

    const token = generateWebhookToken();
    try {
      const reference = this.vault.save(token, existingReference);
      this.database.setSetting(TOKEN_REFERENCE_KEY, reference);
    } catch {
      // Encryption unavailable: the token still works for this session, it just is
      // not remembered. Better than refusing to run the feature at all.
      this.log("⚠ Webhook token could not be saved to the encrypted vault; it will change on restart.");
    }
    this.token = token;
    return token;
  }

  /** Replaces the token, invalidating anything already configured with the old one. */
  rotateToken(): string {
    const existingReference = this.database.getSetting(TOKEN_REFERENCE_KEY);
    const token = generateWebhookToken();
    const reference = this.vault.save(token, existingReference);
    this.database.setSetting(TOKEN_REFERENCE_KEY, reference);
    this.token = token;
    return token;
  }

  private log(message: string): void {
    this.webContentsProvider()?.send("workflow:event", {
      type: "workflow:log",
      workflowId: "",
      workflowRunId: "",
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
