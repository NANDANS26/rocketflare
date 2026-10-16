DROP INDEX "agent_runs_active_exclusive_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "exclusive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_exclusive_idx" ON "agent_runs" USING btree ("tenant_id","agent_key") WHERE "agent_runs"."exclusive" AND "agent_runs"."status" IN ('queued', 'running', 'awaiting_input');