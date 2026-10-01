import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { CardSkeleton, Card } from "../components/app/card.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField, type FieldControl } from "../components/app/form-field.js";
import { PageHeader } from "../components/app/page.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { StatusPill } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import type { Result } from "../contract/respond.js";
import {
  CONNECTOR_FLOW_PARAM,
  CONNECTOR_PRODUCT_NAME,
  RESTART_FROM_CLIENT,
  type ConnectorScope,
} from "./contracts.js";
import type { ConnectorConsentSummary, ConnectorMachine, ConnectorRedirect } from "./flow.js";
import {
  decidePaseoConnectorConsent,
  describePaseoConnectorConsent,
  listPaseoConnectorConnections,
  listPaseoConnectorMachines,
  revokePaseoConnectorConnection,
  selectPaseoConnectorMachine,
  type ConnectorConnectionView,
} from "./functions.js";

/** What each connector scope lets the connected app do, in the words the consent page uses. */
const SCOPES: Record<ConnectorScope, { label: string; description: string }> = {
  "paseo:read": {
    label: "See its own work",
    description:
      "See this connection, the machine's agent runtimes, and the agents this connector started.",
  },
  "paseo:run": {
    label: "Start agents",
    description: "Start agents and send them follow-ups in the working directory.",
  },
  "paseo:cancel": {
    label: "Stop a running turn",
    description: "Stop an agent's current turn without deleting its session.",
  },
};

const CONNECTIONS_PATH = "/oauth/connections";

/**
 * The authorization request this page was opened with, read once from the browser's own URL.
 *
 * Never from the router: its search parser turns the repeated `ba_param` entries of the library's
 * signed query into one JSON array, so a query rebuilt from router state no longer matches its
 * signature. Hub moves between the connector pages with full page loads for the same reason.
 */
interface SignedRequest {
  /** The query string exactly as the browser received it. */
  query: string;
  flowId: string | undefined;
  expired: boolean;
}

function readSignedRequest(): SignedRequest | undefined {
  if (typeof window === "undefined") return undefined;
  const query = window.location.search;
  const params = new URLSearchParams(query);
  if (!params.has("sig") || !params.has("client_id")) return undefined;
  const expiresAt = Number(params.get("exp")) * 1000;
  return {
    query,
    flowId: params.get(CONNECTOR_FLOW_PARAM) ?? undefined,
    expired: !Number.isFinite(expiresAt) || expiresAt <= Date.now(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ConnectionsLink() {
  return (
    <Button asChild variant="outline">
      <Link to={CONNECTIONS_PATH}>Connected apps</Link>
    </Button>
  );
}

/** The page an authorization request lands on when it cannot be continued at all. */
function UnusableRequest({
  title,
  description,
  problem,
  message,
}: {
  title: string;
  description: string;
  problem: string;
  message: string;
}) {
  return (
    <>
      <PageHeader title={title} description={description}>
        <ConnectionsLink />
      </PageHeader>
      <FailureAlert title={problem} error={message} fallback={message} />
    </>
  );
}

const MISSING_REQUEST = `This page needs the authorization request an MCP client sends when it connects to the ${CONNECTOR_PRODUCT_NAME}. ${RESTART_FROM_CLIENT}`;
const EXPIRED_REQUEST = `This authorization request expired. ${RESTART_FROM_CLIENT}`;

function machineOption(machine: ConnectorMachine): ComboboxOption {
  let state = "Not allowed to run Hub automations";
  if (machine.canRunHubWork) state = machine.presence === "connected" ? "Connected" : "Offline";
  return {
    value: machine.daemonId,
    label: machine.name,
    detail: `${machine.organizationName} · ${state}`,
    keywords: [machine.name, machine.organizationName],
    disabled: !machine.canRunHubWork,
  };
}

const CONNECT_TITLE = "Connect a machine";
const CONNECT_DESCRIPTION = `Choose the one machine and working directory the app connecting through the ${CONNECTOR_PRODUCT_NAME} may use. You approve what it can do on the next step.`;
const NO_MACHINES = {
  title: "No machines to connect",
  description: `Only owners and admins can connect an organization's machines to the ${CONNECTOR_PRODUCT_NAME}. Enroll a Paseo daemon in an organization you manage, then start connecting again from your MCP client.`,
};
const MACHINES_FAILURE = "Hub did not return your machines. Check your connection and try again.";
const SELECT_FAILURE =
  "Hub did not receive this selection. Check your connection and submit again.";

/** `/oauth/connect`: bind one authorization request to one machine and one directory. */
export function ConnectorConnect() {
  const [request] = useState(readSignedRequest);
  const loadMachines = useServerFn(listPaseoConnectorMachines) as () => Promise<
    Result<readonly ConnectorMachine[]>
  >;
  const machines = useQuery({
    queryKey: ["paseo-connector", "machines"],
    queryFn: () => loadMachines(),
    enabled: request !== undefined && !request.expired,
  });
  const select = useMutation({
    mutationFn: useServerFn(selectPaseoConnectorMachine) as (
      input: Parameters<typeof selectPaseoConnectorMachine>[0],
    ) => Promise<Result<ConnectorRedirect>>,
    onSuccess: (result) => {
      if (result.status === "ok") window.location.assign(result.data.redirectTo);
    },
  });
  const [daemonId, setDaemonId] = useState("");
  const choose = useCallback((option: ComboboxOption) => setDaemonId(option.value), []);
  const reload = useCallback(() => void machines.refetch(), [machines]);
  const options = useMemo(
    () =>
      machines.data?.status === "ok"
        ? machines.data.data.map((machine) => machineOption(machine))
        : [],
    [machines.data],
  );
  const renderMachine = useCallback(
    (control: FieldControl) => (
      <Combobox
        {...control}
        value={daemonId}
        options={options}
        onChange={choose}
        placeholder="Select a machine"
        searchPlaceholder="Search machines…"
        empty="No machines found."
      />
    ),
    [choose, daemonId, options],
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (request === undefined || daemonId === "") return;
      const directory = new FormData(event.currentTarget).get("workingDirectory");
      select.mutate({
        data: {
          oauthQuery: request.query,
          daemonId,
          workingDirectory: typeof directory === "string" ? directory : "",
        },
      });
    },
    [daemonId, request, select],
  );

  if (request === undefined) {
    return (
      <UnusableRequest
        title={CONNECT_TITLE}
        description={CONNECT_DESCRIPTION}
        problem="No authorization request"
        message={MISSING_REQUEST}
      />
    );
  }
  if (request.expired) {
    return (
      <UnusableRequest
        title={CONNECT_TITLE}
        description={CONNECT_DESCRIPTION}
        problem="Authorization request expired"
        message={EXPIRED_REQUEST}
      />
    );
  }
  const header = (
    <PageHeader title={CONNECT_TITLE} description={CONNECT_DESCRIPTION}>
      <ConnectionsLink />
    </PageHeader>
  );
  if (machines.isPending) {
    return (
      <>
        {header}
        <CardSkeleton lines={4} />
      </>
    );
  }
  if (machines.isError || machines.data.status === "error") {
    return (
      <>
        {header}
        <FailureAlert
          title="Machines unavailable"
          error={machines.data}
          fallback={MACHINES_FAILURE}
          onRetry={reload}
        />
      </>
    );
  }
  if (options.length === 0) {
    return (
      <>
        {header}
        <EmptyState title={NO_MACHINES.title} description={NO_MACHINES.description} />
      </>
    );
  }
  const leaving = select.data?.status === "ok";
  const busy = select.isPending || leaving;
  const failed = select.isError || select.data?.status === "error";
  const blocked = options.some((option) => option.disabled === true);
  return (
    <>
      {header}
      <Card>
        <form className="grid gap-4" onSubmit={submit} aria-label={CONNECT_TITLE}>
          <FormField
            id="connector-machine"
            label="Machine"
            description={
              blocked
                ? "Machines not allowed to run Hub automations can't be connected until you run paseo hub permissions grant hub.execute on them."
                : "The connection can reach this machine and nothing else."
            }
            required
          >
            {renderMachine}
          </FormField>
          <FormField
            kind="text"
            id="connector-working-directory"
            name="workingDirectory"
            label="Working directory"
            description="An absolute path on that machine. Agents this connection starts run in this directory."
            pattern="/.*"
            maxLength={4096}
            required
          />
          {failed ? (
            <FailureAlert
              title="Machine not selected"
              error={select.data}
              fallback={SELECT_FAILURE}
              focusOnArrival
            />
          ) : null}
          <FormActions>
            <Button type="submit" disabled={busy || daemonId === ""}>
              Continue
            </Button>
          </FormActions>
        </form>
      </Card>
    </>
  );
}

/** How a client's self-declared name is shown wherever Hub names the app. */
const NO_CLIENT_NAME = "No name given";
const UNVERIFIED_CLIENT_NAME = "Name provided by the app itself, not verified by Hub";

const CONSENT_TITLE = "Approve access";
const CONSENT_DESCRIPTION = `Review what this app may do through the ${CONNECTOR_PRODUCT_NAME} on the machine you chose, then approve or deny it.`;
const CONSENT_FAILURE = "Hub did not return this authorization. Check your connection and reload.";
const DECISION_FAILURE =
  "Hub did not receive your decision. Check your connection and submit again.";

/** `/oauth/consent`: what the selected flow grants, and the decision that finishes it. */
export function ConnectorConsent() {
  const [request] = useState(readSignedRequest);
  const flowId = request?.flowId;
  const usable = request !== undefined && flowId !== undefined && UUID.test(flowId);
  const describe = useServerFn(describePaseoConnectorConsent) as (
    input: Parameters<typeof describePaseoConnectorConsent>[0],
  ) => Promise<Result<ConnectorConsentSummary>>;
  const summary = useQuery({
    queryKey: ["paseo-connector", "consent", flowId],
    queryFn: () => describe({ data: { oauthQuery: request?.query ?? "", flowId: flowId ?? "" } }),
    enabled: usable && !request.expired,
    // The flow is single-use: a background refetch after approval would only report it gone.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const decide = useMutation({
    mutationFn: useServerFn(decidePaseoConnectorConsent) as (
      input: Parameters<typeof decidePaseoConnectorConsent>[0],
    ) => Promise<Result<ConnectorRedirect>>,
    onSuccess: (result) => {
      if (result.status === "ok") window.location.assign(result.data.redirectTo);
    },
  });
  // Each button carries its own decision. Nothing is inferred from a form submission, so no path
  // (a missing SubmitEvent.submitter, requestSubmit, the Enter key) can approve without Approve.
  const decideWith = useCallback(
    (accept: boolean) => {
      if (request === undefined || flowId === undefined) return;
      decide.mutate({ data: { oauthQuery: request.query, flowId, accept } });
    },
    [decide, flowId, request],
  );
  const approve = useCallback(() => decideWith(true), [decideWith]);
  const deny = useCallback(() => decideWith(false), [decideWith]);
  const reload = useCallback(() => void summary.refetch(), [summary]);

  if (!usable) {
    return (
      <UnusableRequest
        title={CONSENT_TITLE}
        description={CONSENT_DESCRIPTION}
        problem="No authorization to approve"
        message={MISSING_REQUEST}
      />
    );
  }
  if (request.expired) {
    return (
      <UnusableRequest
        title={CONSENT_TITLE}
        description={CONSENT_DESCRIPTION}
        problem="Authorization request expired"
        message={EXPIRED_REQUEST}
      />
    );
  }
  const header = (
    <PageHeader title={CONSENT_TITLE} description={CONSENT_DESCRIPTION}>
      <ConnectionsLink />
    </PageHeader>
  );
  if (summary.isPending) {
    return (
      <>
        {header}
        <CardSkeleton lines={4} />
      </>
    );
  }
  if (summary.isError || summary.data.status === "error") {
    return (
      <>
        {header}
        <FailureAlert
          title="Authorization unavailable"
          error={summary.data}
          fallback={CONSENT_FAILURE}
          onRetry={reload}
        />
      </>
    );
  }
  const busy = decide.isPending || decide.data?.status === "ok";
  const failed = decide.isError || decide.data?.status === "error";
  return (
    <>
      {header}
      <ConsentSummary summary={summary.data.data} />
      <Card
        title="Permissions"
        description="You can revoke this connection at any time from Connected apps. Revoking does not stop agents already running."
      >
        <RecordList label="Permissions">
          {summary.data.data.scopes.map((scope) => (
            <RecordRow key={scope}>
              <TwoLine primary={SCOPES[scope].label} secondary={SCOPES[scope].description} wrap />
            </RecordRow>
          ))}
        </RecordList>
        <div className="grid gap-4" role="group" aria-label="Decision">
          {failed ? (
            <FailureAlert
              title="Decision not recorded"
              error={decide.data}
              fallback={DECISION_FAILURE}
              focusOnArrival
            />
          ) : null}
          <FormActions>
            <Button type="button" variant="outline" disabled={busy} onClick={deny}>
              Deny
            </Button>
            <Button type="button" disabled={busy} onClick={approve}>
              Approve
            </Button>
          </FormActions>
        </div>
      </Card>
    </>
  );
}

function ConsentSummary({ summary }: { summary: ConnectorConsentSummary }) {
  const rows = useMemo<SummaryRow[]>(
    () => [
      {
        label: "App",
        value: (
          <TwoLine
            primary={summary.clientName ?? NO_CLIENT_NAME}
            secondary={UNVERIFIED_CLIENT_NAME}
            wrap
          />
        ),
      },
      {
        label: "Approval sends you and the access code to",
        value: (
          <span className="font-mono">{summary.redirectTarget ?? "An unreadable address"}</span>
        ),
      },
      {
        label: "Machine",
        value: <TwoLine primary={summary.machineName} secondary={summary.organizationName} wrap />,
      },
      {
        label: "Working directory",
        value: <span className="font-mono">{summary.workingDirectory}</span>,
      },
      {
        label: "Access lasts",
        value: summary.staysConnected
          ? "Until you revoke it"
          : "Until its current access token expires",
      },
    ],
    [summary],
  );
  return <SummaryPanel label="Authorization" rows={rows} />;
}

const CONNECTION_COLUMNS = [
  { header: "App" },
  { header: "Machine" },
  { header: "Permissions" },
  { header: "Connected" },
  { header: "Status" },
  { header: "", align: "end" as const },
];
const NO_CONNECTIONS = {
  title: "No connections",
  description: `Connect an MCP client to the ${CONNECTOR_PRODUCT_NAME} and the connection appears here.`,
};
const CONNECTIONS_FAILURE =
  "Hub did not return your connections. Check your connection and reload.";
const REVOKE_FAILURE =
  "Hub did not receive the revocation. Reload the list to confirm the connection's status.";

/** `/oauth/connections`: every connection the user approved, and the way to revoke one. */
export function ConnectorConnections() {
  const queryClient = useQueryClient();
  const load = useServerFn(listPaseoConnectorConnections) as () => Promise<
    Result<readonly ConnectorConnectionView[]>
  >;
  const connections = useQuery({
    queryKey: ["paseo-connector", "connections"],
    queryFn: () => load(),
  });
  const revoke = useMutation({
    mutationFn: useServerFn(revokePaseoConnectorConnection) as (
      input: Parameters<typeof revokePaseoConnectorConnection>[0],
    ) => Promise<Result<{ revoked: boolean }>>,
    onSuccess: async (result) => {
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["paseo-connector", "connections"] });
      }
    },
  });
  const reload = useCallback(() => void connections.refetch(), [connections]);
  const header = (
    <PageHeader
      title="Connected apps"
      description={`Apps you connected through the ${CONNECTOR_PRODUCT_NAME}, each limited to one machine and one working directory. Revoking one blocks its further access but does not stop agents already running.`}
    />
  );
  if (connections.isPending) {
    return (
      <>
        {header}
        <DataTableSkeleton label="Connected apps" columns={CONNECTION_COLUMNS} rows={2} />
      </>
    );
  }
  if (connections.isError || connections.data.status === "error") {
    return (
      <>
        {header}
        <FailureAlert
          title="Connections unavailable"
          error={connections.data}
          fallback={CONNECTIONS_FAILURE}
          onRetry={reload}
        />
      </>
    );
  }
  const records = connections.data.data;
  const revokeFailed = revoke.isError || revoke.data?.status === "error";
  return (
    <>
      {header}
      {revokeFailed ? (
        <FailureAlert
          title="Connection not revoked"
          error={revoke.data}
          fallback={REVOKE_FAILURE}
          standalone
        />
      ) : null}
      <DataTable
        label="Connected apps"
        columns={CONNECTION_COLUMNS}
        isEmpty={records.length === 0}
        empty={NO_CONNECTIONS}
      >
        {records.map((record) => (
          <ConnectionRow
            key={record.connectionId}
            record={record}
            busy={revoke.isPending}
            onRevoke={revoke.mutate}
          />
        ))}
      </DataTable>
    </>
  );
}

function ConnectionRow({
  record,
  busy,
  onRevoke,
}: {
  record: ConnectorConnectionView;
  busy: boolean;
  onRevoke: (input: { data: { connectionId: string } }) => void;
}) {
  const revoke = useCallback(
    () => onRevoke({ data: { connectionId: record.connectionId } }),
    [onRevoke, record.connectionId],
  );
  const machine = record.machineName ?? "Removed machine";
  const app = record.clientName ?? NO_CLIENT_NAME;
  return (
    <DataRow>
      <DataCell>
        <TwoLine primary={app} secondary={UNVERIFIED_CLIENT_NAME} />
      </DataCell>
      <DataCell>
        <TwoLine primary={machine} secondary={record.workingDirectory} mono />
      </DataCell>
      <DataCell muted>{record.scopes.map((scope) => SCOPES[scope].label).join(", ")}</DataCell>
      <DataCell muted>
        <RelativeTime value={record.activatedAt} />
      </DataCell>
      <DataCell>
        {record.revokedAt === null ? (
          <StatusPill tone="success">Active</StatusPill>
        ) : (
          <StatusPill tone="neutral">Revoked</StatusPill>
        )}
      </DataCell>
      <DataCell align="end">
        {record.revokedAt === null ? (
          <RowActions label={`Actions for ${app} on ${machine} ${record.workingDirectory}`}>
            <ConfirmMenuItem
              label="Revoke"
              destructive
              title="Revoke this connection?"
              description={`${record.clientName ?? "The app"} loses access to ${machine} through this connection right away. Agents it already started keep running.`}
              confirmLabel="Revoke connection"
              cancelLabel="Cancel"
              busy={busy}
              onConfirm={revoke}
            />
          </RowActions>
        ) : null}
      </DataCell>
    </DataRow>
  );
}
