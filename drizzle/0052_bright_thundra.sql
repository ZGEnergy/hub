CREATE TABLE "connector_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"daemon_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"launch_operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"daemon_id" uuid NOT NULL,
	"working_directory" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "connector_connections_identity_unique" UNIQUE("id","owner_user_id","organization_id","daemon_id"),
	CONSTRAINT "connector_connections_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "connector_connections_scopes_check" CHECK ("connector_connections"."scopes" <@ ARRAY['paseo:read', 'paseo:run', 'paseo:cancel']::text[] and cardinality("connector_connections"."scopes") > 0)
);
--> statement-breakpoint
CREATE TABLE "connector_consent_flows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"authorization_fingerprint" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"daemon_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"creation_key" text,
	"message_id" text NOT NULL,
	"agent_id" text,
	"workspace_id" text,
	"state" text NOT NULL,
	"error_code" text,
	CONSTRAINT "connector_operations_identity_unique" UNIQUE("id","connection_id","owner_user_id","organization_id","daemon_id"),
	CONSTRAINT "connector_operations_kind_check" CHECK ("connector_operations"."kind" in ('launch', 'message')),
	CONSTRAINT "connector_operations_state_check" CHECK ("connector_operations"."state" in ('creating', 'created', 'accepted', 'failed', 'outcome_unknown'))
);
--> statement-breakpoint
ALTER TABLE "connector_agents" ADD CONSTRAINT "connector_agents_connection_identity_fk" FOREIGN KEY ("connection_id","owner_user_id","organization_id","daemon_id") REFERENCES "public"."connector_connections"("id","owner_user_id","organization_id","daemon_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_agents" ADD CONSTRAINT "connector_agents_operation_identity_fk" FOREIGN KEY ("launch_operation_id","connection_id","owner_user_id","organization_id","daemon_id") REFERENCES "public"."connector_operations"("id","connection_id","owner_user_id","organization_id","daemon_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_agents" ADD CONSTRAINT "connector_agents_daemon_organization_fk" FOREIGN KEY ("daemon_id","organization_id") REFERENCES "public"."daemons"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_daemon_organization_fk" FOREIGN KEY ("daemon_id","organization_id") REFERENCES "public"."daemons"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_consent_flows" ADD CONSTRAINT "connector_consent_flows_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_consent_flows" ADD CONSTRAINT "connector_consent_flows_connection_owner_fk" FOREIGN KEY ("connection_id","owner_user_id") REFERENCES "public"."connector_connections"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_operations" ADD CONSTRAINT "connector_operations_connection_identity_fk" FOREIGN KEY ("connection_id","owner_user_id","organization_id","daemon_id") REFERENCES "public"."connector_connections"("id","owner_user_id","organization_id","daemon_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_operations" ADD CONSTRAINT "connector_operations_daemon_organization_fk" FOREIGN KEY ("daemon_id","organization_id") REFERENCES "public"."daemons"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_agents_daemon_agent_unique" ON "connector_agents" USING btree ("daemon_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_agents_launch_operation_unique" ON "connector_agents" USING btree ("launch_operation_id");--> statement-breakpoint
CREATE INDEX "connector_agents_connection_idx" ON "connector_agents" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_connections_owner_created_idx" ON "connector_connections" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "connector_connections_daemon_idx" ON "connector_connections" USING btree ("daemon_id","organization_id");--> statement-breakpoint
CREATE INDEX "connector_consent_flows_owner_session_idx" ON "connector_consent_flows" USING btree ("owner_user_id","session_id");--> statement-breakpoint
CREATE INDEX "connector_consent_flows_connection_idx" ON "connector_consent_flows" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_operations_connection_request_key_unique" ON "connector_operations" USING btree ("connection_id","request_key");