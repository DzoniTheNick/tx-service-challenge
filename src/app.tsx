import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { MCPServersState } from "agents";
import type { ChatAgent } from "./server";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
  PlugsConnectedIcon,
  WrenchIcon,
  UserCircleIcon,
  WarningCircleIcon,
  ListMagnifyingGlassIcon
} from "@phosphor-icons/react";

// ── Users (must match the server's fixed list in src/identity.ts) ─────────
const USERS = [
  { id: "alice", label: "Alice", role: "Employee" },
  { id: "bob", label: "Bob", role: "IT admin" },
  { id: "charlie", label: "Charlie", role: "HR admin" }
] as const;
type UserId = (typeof USERS)[number]["id"];

interface TraceRow {
  id: string;
  ts: string;
  turnId: string;
  agent: string;
  event: string;
  detailJson: string;
}

// ── Small components ──────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") !== "light"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function BrandMark({ role }: { role: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="inline-block h-6 w-1.5 rounded-full"
        style={{ background: "var(--tx-mint)" }}
        aria-hidden
      />
      <h1 className="text-lg font-semibold text-kumo-strong leading-none">
        TX Service <span className="text-kumo-subtle font-normal">—</span>{" "}
        <span style={{ color: "var(--tx-mint)" }}>Help Desk</span>
      </h1>
      <Badge variant="secondary">{role}</Badge>
    </div>
  );
}

function UserSwitcher({
  userId,
  onSwitch
}: {
  userId: UserId;
  onSwitch: (id: UserId) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <UserCircleIcon size={18} className="text-kumo-subtle" />
      <div className="flex rounded-lg border border-kumo-line overflow-hidden">
        {USERS.map((u) => {
          const active = u.id === userId;
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => onSwitch(u.id)}
              aria-pressed={active}
              className={`px-2.5 py-1 text-xs transition-colors ${
                active
                  ? "text-kumo-inverse font-semibold"
                  : "text-kumo-subtle hover:text-kumo-default"
              }`}
              style={active ? { background: "var(--tx-mint)" } : undefined}
              title={`${u.label} — ${u.role}`}
            >
              {u.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function McpStatus({ mcp }: { mcp: MCPServersState }) {
  const servers = Object.values(mcp.servers);
  const ready = servers.some((s) => s.state === "ready");
  const failed = servers.some((s) => s.state === "failed");
  const toolCount = mcp.tools.length;
  const [label, color] = ready
    ? ([
        `MCP · ${toolCount} tool${toolCount === 1 ? "" : "s"}`,
        "text-kumo-success"
      ] as const)
    : failed
      ? (["MCP · unavailable", "text-kumo-danger"] as const)
      : (["MCP · connecting", "text-kumo-subtle"] as const);
  // Hover lists the active (discovered) MCP tool names.
  const names = mcp.tools.map((t) => t.name);
  const title =
    names.length > 0
      ? `Active MCP tools (read-only):\n${names.map((n) => `• ${n}`).join("\n")}`
      : "MCP server status (read-only)";
  return (
    <div className="flex items-center gap-1.5 cursor-help" title={title}>
      <PlugsConnectedIcon size={14} className={color} />
      <Text size="xs" variant="secondary">
        {label}
      </Text>
    </div>
  );
}

function ErrorBanner({
  message,
  onDismiss
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="px-5 py-2 bg-kumo-danger-tint border-b border-kumo-line">
      <div className="max-w-3xl mx-auto flex items-center gap-2">
        <WarningCircleIcon size={16} className="text-kumo-danger shrink-0" />
        <Text size="sm" variant="secondary">
          {message}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function TracePanel({
  open,
  rows,
  loading,
  onRefresh
}: {
  open: boolean;
  rows: TraceRow[];
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!open) return null;
  return (
    <div className="border-t border-kumo-line bg-kumo-base max-h-64 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 py-3">
        <div className="flex items-center gap-2 mb-2">
          <ListMagnifyingGlassIcon size={14} className="text-kumo-subtle" />
          <Text size="xs" bold variant="secondary">
            Trace {rows.length > 0 ? `(${rows.length} events)` : ""}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onRefresh}
          >
            {loading ? "…" : "Refresh"}
          </Button>
        </div>
        {rows.length === 0 ? (
          <Text size="xs" variant="secondary">
            No trace yet — send a message, then refresh.
          </Text>
        ) : (
          <table className="w-full text-[11px] font-mono">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-kumo-hairline/60">
                  <td className="py-0.5 pr-2 text-kumo-subtle whitespace-nowrap">
                    {r.ts.slice(11, 23)}
                  </td>
                  <td className="py-0.5 pr-2 text-kumo-subtle">{r.agent}</td>
                  <td
                    className="py-0.5 pr-2"
                    style={{ color: "var(--tx-mint)" }}
                  >
                    {r.event}
                  </td>
                  <td className="py-0.5 text-kumo-default truncate max-w-[18rem]">
                    {r.detailJson}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Tool rendering ─────────────────────────────────────────────────────────

function ToolIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {text}
      </pre>
    </div>
  );
}

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <WrenchIcon size={14} className="text-kumo-subtle" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <ToolIO label="Input" value={part.input} />
          <ToolIO label="Output" value={part.output} />
        </Surface>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: true })
              }
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: false })
              }
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger">
          <div className="flex items-center gap-2 mb-1">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {part.errorText || "Tool call failed"}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-subtle animate-spin" />
            <Text size="xs" variant="secondary">
              Running {toolName}…
            </Text>
          </div>
          <ToolIO label="Input" value={part.input} />
        </Surface>
      </div>
    );
  }

  return null;
}

/** An interactive approval card is always shown (the turn is blocked on it). */
function isApprovalPart(part: UIMessage["parts"][number]): boolean {
  return (
    isToolUIPart(part) &&
    "approval" in part &&
    part.state === "approval-requested"
  );
}

/**
 * Whether a message already shows something to the user. `step-start` and
 * empty parts don't count, so the loading indicator stays up until real output
 * actually appears. With rich responses OFF, reasoning and tool cards are
 * hidden, so they don't count — the indicator keeps running through them until
 * the final answer text appears (an approval card is the one exception: it is
 * always visible and blocks the turn).
 */
function hasVisibleContent(message: UIMessage, showRich: boolean): boolean {
  return message.parts.some((part) => {
    if (isToolUIPart(part)) return showRich || isApprovalPart(part);
    if (part.type === "text") return part.text.length > 0;
    if (part.type === "reasoning") {
      return showRich && part.text.trim().length > 0;
    }
    return false;
  });
}

/** Format elapsed milliseconds as `5s` or, past a minute, `1:05`. */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Animated "assistant is working" indicator with live elapsed time + retries. */
function LoadingBubble({
  elapsedMs,
  retries
}: {
  elapsedMs: number;
  retries: number;
}) {
  return (
    <div
      className="flex justify-start items-center gap-2.5"
      aria-live="polite"
      aria-label="Assistant is working"
    >
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-kumo-base ring-1 ring-kumo-line px-4 py-3.5">
        <span className="tx-typing-dot" />
        <span className="tx-typing-dot" />
        <span className="tx-typing-dot" />
      </div>
      <Text size="xs" variant="secondary">
        Working · {formatElapsed(elapsedMs)}
      </Text>
      {retries > 0 && (
        <Badge variant="secondary">
          {retries === 1 ? "1 retry" : `${retries} retries`}
        </Badge>
      )}
    </div>
  );
}

// ── Main chat (one instance = one session) ─────────────────────────────────

const EXAMPLE_PROMPTS = [
  "The VPN seems to be down — can you check and help?",
  "How many annual leave days do I get, and what's the carry-over?",
  "I'm a new engineer — what equipment do I get?",
  "Can you reset my password?"
];

function Chat({
  userId,
  sessionId,
  onSwitchUser
}: {
  userId: UserId;
  sessionId: string;
  onSwitchUser: (id: UserId) => void;
}) {
  const instanceName = `${userId}:${sessionId}`;
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showRich, setShowRich] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [showTrace, setShowTrace] = useState(false);
  const [trace, setTrace] = useState<TraceRow[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  // Live turn progress: elapsed time and retry count (from specialist_retry
  // trace events the server persists as a turn runs).
  const [elapsedMs, setElapsedMs] = useState(0);
  const [retries, setRetries] = useState(0);
  const turnStartRef = useRef<number | null>(null);
  // How long each completed turn took (assistant message id → ms), shown on the
  // finished answer.
  const [durations, setDurations] = useState<Record<string, number>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    name: instanceName,
    query: { _user: userId },
    queryDeps: [userId],
    onOpen: useCallback(() => {
      setConnected(true);
      setError(null);
    }, []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      () => setError("Connection error — the assistant is unreachable."),
      []
    ),
    onMcpUpdate: useCallback((state: MCPServersState) => setMcpState(state), [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    experimental_throttle: 100,
    // Turn failures surface as an event, not by polling `status` in an effect.
    onError: useCallback(
      () => setError("The last turn failed. Please try again."),
      []
    ),
    // Record how long the turn took, keyed by the finished assistant message.
    onFinish: useCallback((opts: { message: UIMessage }) => {
      const start = turnStartRef.current;
      if (start != null && opts.message.role === "assistant") {
        const took = Date.now() - start;
        setDurations((d) => ({ ...d, [opts.message.id]: took }));
      }
    }, [])
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const refreshTrace = useCallback(async () => {
    setTraceLoading(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(instanceName)}/trace`,
        { headers: { "X-User": userId } }
      );
      if (!res.ok) throw new Error(`trace ${res.status}`);
      const data = (await res.json()) as { trace: TraceRow[] };
      setTrace(data.trace ?? []);
    } catch {
      setError("Could not load the trace for this session.");
    } finally {
      setTraceLoading(false);
    }
  }, [instanceName, userId]);

  // Auto-refresh the trace when it is open and a turn completes. Fetching a
  // server-side resource (the DO's trace store) is exactly what effects are
  // for; the synchronous loading-state set is part of that fetch.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (showTrace && !isStreaming) void refreshTrace();
  }, [showTrace, isStreaming, refreshTrace]);

  // Start a turn: reset the live progress counters (event-driven), then send.
  const submitTurn = useCallback(
    (text: string) => {
      turnStartRef.current = Date.now();
      setElapsedMs(0);
      setRetries(0);
      sendMessage({ role: "user", parts: [{ type: "text", text }] });
    },
    [sendMessage]
  );

  // While a turn runs, tick the elapsed timer (every 1s) and poll the trace
  // (every ~3s) to surface retry events live. setState happens only inside the
  // interval callback, never synchronously in the effect body.
  useEffect(() => {
    if (!isStreaming) return;
    const start = turnStartRef.current ?? Date.now();
    turnStartRef.current = start;
    let tick = 0;
    const iv = setInterval(() => {
      setElapsedMs(Date.now() - start);
      tick += 1;
      if (tick % 3 !== 0) return;
      void (async () => {
        try {
          const res = await fetch(
            `/api/sessions/${encodeURIComponent(instanceName)}/trace`,
            { headers: { "X-User": userId } }
          );
          if (!res.ok) return;
          const data = (await res.json()) as { trace: TraceRow[] };
          const n = (data.trace ?? []).filter(
            (r) => r.event === "specialist_retry" && Date.parse(r.ts) >= start
          ).length;
          setRetries(n);
        } catch {
          /* ignore transient poll errors */
        }
      })();
    }, 1000);
    return () => clearInterval(iv);
  }, [isStreaming, instanceName, userId]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    submitTurn(text);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, submitTurn]);

  const activeUser = useMemo(
    () => USERS.find((u) => u.id === userId)!,
    [userId]
  );

  // Show the "working" indicator from the moment a turn is submitted until the
  // assistant actually starts producing output (reasoning, text, or a tool
  // call). A bare assistant message with only a step-start does not count.
  const lastMessage = messages[messages.length - 1];
  const waiting =
    isStreaming && (!lastMessage || !hasVisibleContent(lastMessage, showRich));

  return (
    <div className="flex flex-col h-screen bg-kumo-canvas">
      {/* Header */}
      <header className="px-5 py-3 bg-kumo-elevated border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <BrandMark role={activeUser.role} />
          <div className="flex items-center gap-3">
            <UserSwitcher userId={userId} onSwitch={onSwitchUser} />
            <ThemeToggle />
          </div>
        </div>
        <div className="max-w-3xl mx-auto mt-2 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <CircleIcon
              size={8}
              weight="fill"
              className={connected ? "text-kumo-success" : "text-kumo-danger"}
            />
            <Text size="xs" variant="secondary">
              {connected ? "Connected" : "Disconnected"}
            </Text>
          </div>
          <McpStatus mcp={mcpState} />
          <div className="flex items-center gap-1.5">
            <BrainIcon size={14} className="text-kumo-subtle" />
            <Text size="xs" variant="secondary">
              Rich responses
            </Text>
            <Switch
              checked={showRich}
              onCheckedChange={setShowRich}
              size="sm"
              aria-label="Show rich responses (reasoning and tool activity)"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <ListMagnifyingGlassIcon size={14} className="text-kumo-subtle" />
            <Text size="xs" variant="secondary">
              Trace
            </Text>
            <Switch
              checked={showTrace}
              onCheckedChange={setShowTrace}
              size="sm"
              aria-label="Show execution trace"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <BugIcon size={14} className="text-kumo-subtle" />
            <Text size="xs" variant="secondary">
              Debug
            </Text>
            <Switch
              checked={showDebug}
              onCheckedChange={setShowDebug}
              size="sm"
              aria-label="Toggle debug mode"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<TrashIcon size={14} />}
            onClick={clearHistory}
            className="ml-auto"
          >
            Clear
          </Button>
        </div>
      </header>

      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title={`Hi, ${activeUser.label}. How can IT or HR help?`}
              contents={
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      disabled={isStreaming || !connected}
                      onClick={() => submitTurn(prompt)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            // Index of the last tool call in this message. Assistant text that
            // precedes it is preamble ("I'll ask the HR specialist…"); only the
            // text after the last tool call is the final answer we want to show.
            const lastToolIdx = message.parts.reduce(
              (acc, part, i) => (isToolUIPart(part) ? i : acc),
              -1
            );
            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}
                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;
                  if (isToolUIPart(part)) {
                    // Tool activity (e.g. "Running delegate…", inputs/outputs)
                    // is hidden unless "Rich responses" is on — but an approval
                    // request always shows, since the turn is blocked on it.
                    if (!showRich && !isApprovalPart(part)) return null;
                    return (
                      <ToolPartView
                        key={key}
                        part={part}
                        addToolApprovalResponse={addToolApprovalResponse}
                      />
                    );
                  }
                  if (part.type === "reasoning") {
                    // Hidden unless the user opts in via "Rich responses".
                    if (!showRich || !part.text.trim()) return null;
                    return (
                      <div key={key} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-kumo-control border border-kumo-line text-sm select-none">
                            <BrainIcon size={14} className="text-kumo-subtle" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-subtle"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {part.text}
                          </pre>
                        </details>
                      </div>
                    );
                  }
                  if (part.type === "text") {
                    if (!part.text) return null;
                    if (isUser) {
                      return (
                        <div key={key} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed font-medium">
                            {part.text}
                          </div>
                        </div>
                      );
                    }
                    // Drop assistant preamble that precedes a delegate/tool
                    // call; keep only the final answer (text after the last
                    // tool). Turns with no tool call (e.g. clarifications) are
                    // unaffected.
                    if (lastToolIdx >= 0 && i < lastToolIdx) return null;
                    return (
                      <div key={key} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed ring-1 ring-kumo-line">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })}
                {!isUser && durations[message.id] != null && (
                  <div className="flex justify-start pl-1">
                    <Text size="xs" variant="secondary">
                      Handled in {formatElapsed(durations[message.id])}
                    </Text>
                  </div>
                )}
              </div>
            );
          })}
          {waiting && <LoadingBubble elapsedMs={elapsedMs} retries={retries} />}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <TracePanel
        open={showTrace}
        rows={trace}
        loading={traceLoading}
        onRefresh={refreshTrace}
      />

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-elevated">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 focus-within:ring-2 focus-within:ring-kumo-focus focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder={connected ? "Ask IT or HR…" : "Connecting…"}
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
          <div className="block text-center mt-2">
            <Text size="xs" variant="secondary">
              Signed in as {activeUser.label} ({activeUser.role}). Switching
              users starts a new session.
            </Text>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [userId, setUserId] = useState<UserId>("alice");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());

  const switchUser = useCallback((id: UserId) => {
    setUserId(id);
    setSessionId(crypto.randomUUID()); // a session never changes user
  }, []);

  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-subtle">
            Loading…
          </div>
        }
      >
        <Chat
          key={`${userId}:${sessionId}`}
          userId={userId}
          sessionId={sessionId}
          onSwitchUser={switchUser}
        />
      </Suspense>
    </Toasty>
  );
}
