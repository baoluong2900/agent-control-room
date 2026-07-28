"use client";

import {
  Activity,
  Bell,
  Bot,
  Boxes,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Code2,
  Command,
  FileText,
  GitBranch,
  LayoutDashboard,
  Menu,
  Network,
  Rocket,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  TestTube2,
  Users,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

type Accent = "blue" | "cyan" | "purple" | "amber" | "green" | "orange";

type Agent = {
  name: string;
  model: string;
  state: string;
  accent: Accent;
  icon: LucideIcon;
};

const navigation = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Agents", icon: Bot },
  { label: "Projects", icon: Boxes },
  { label: "Workflows", icon: Workflow },
  { label: "Tasks", icon: CircleGauge },
  { label: "Knowledge", icon: FileText },
  { label: "Integrations", icon: Network },
  { label: "Analytics", icon: Activity },
  { label: "Settings", icon: Settings },
];

const agents: Agent[] = [
  { name: "Planner", model: "GPT-4o", state: "Working", accent: "blue", icon: BrainCircuit },
  { name: "Coder", model: "Claude 3.5", state: "Coding", accent: "purple", icon: Code2 },
  { name: "Reviewer", model: "GPT-4o", state: "Reviewing", accent: "green", icon: FileText },
  { name: "Tester", model: "Gemini 1.5", state: "Testing", accent: "amber", icon: TestTube2 },
  { name: "Deployer", model: "GPT-4o", state: "Deploying", accent: "orange", icon: Rocket },
];

const zones = [
  {
    id: "planning",
    title: "PLANNING",
    subtitle: "Strategy & Roadmap",
    accent: "blue" as Accent,
    icon: BrainCircuit,
    task: "Define API Schema",
    role: "Planner",
    eta: "10m",
    status: "In Progress",
    priority: "High",
  },
  {
    id: "documents",
    title: "DOCUMENTS",
    subtitle: "Knowledge Base",
    accent: "purple" as Accent,
    icon: FileText,
    task: "Architecture Doc",
    role: "RAG Search",
    eta: "",
    status: "Completed",
    priority: "",
  },
  {
    id: "code",
    title: "CODE",
    subtitle: "Development Zone",
    accent: "cyan" as Accent,
    icon: Code2,
    task: "Implement Auth",
    role: "Coder",
    eta: "25m",
    status: "In Progress",
    priority: "High",
  },
  {
    id: "testing",
    title: "TESTING",
    subtitle: "Quality Assurance",
    accent: "purple" as Accent,
    icon: TestTube2,
    task: "Run E2E Tests",
    role: "Tester",
    eta: "15m",
    status: "In Progress",
    priority: "",
  },
  {
    id: "monitoring",
    title: "MONITORING",
    subtitle: "Observability & Metrics",
    accent: "orange" as Accent,
    icon: Activity,
    task: "",
    role: "",
    eta: "",
    status: "",
    priority: "",
  },
  {
    id: "deployment",
    title: "DEPLOYMENT",
    subtitle: "CI/CD Pipeline",
    accent: "amber" as Accent,
    icon: Rocket,
    task: "Deploy to Prod",
    role: "Deployer",
    eta: "8m",
    status: "In Progress",
    priority: "",
  },
];

const modelUsage = [
  { name: "GPT-4o", percent: 38.4, tokens: "2.1M", color: "#54d7f3" },
  { name: "Claude 3.5", percent: 28.7, tokens: "1.6M", color: "#ffc75e" },
  { name: "Gemini 1.5", percent: 16.3, tokens: "910K", color: "#62dfa1" },
  { name: "Llama 3.1", percent: 10.2, tokens: "570K", color: "#4f8cff" },
  { name: "Other", percent: 6.4, tokens: "360K", color: "#3475c5" },
];

const workflowEvents = [
  { role: "Planner", event: "Created tasks", time: "2m ago", accent: "blue" as Accent, icon: BrainCircuit },
  { role: "Coder", event: "Pushed changes", time: "4m ago", accent: "purple" as Accent, icon: Code2 },
  { role: "Reviewer", event: "Left comments", time: "6m ago", accent: "green" as Accent, icon: FileText },
  { role: "Tester", event: "Found 2 issues", time: "8m ago", accent: "purple" as Accent, icon: TestTube2 },
  { role: "Deployer", event: "Deployed to staging", time: "10m ago", accent: "orange" as Accent, icon: Rocket },
];

const models = [
  { name: "GPT-4o", note: "Best for general tasks", accent: "green" as Accent, icon: Sparkles },
  { name: "Claude 3.5 Sonnet", note: "Best for coding", accent: "orange" as Accent, icon: Code2 },
  { name: "Gemini 1.5 Pro", note: "Best for long context", accent: "blue" as Accent, icon: Zap },
  { name: "Llama 3.1 70B", note: "Best for open-source", accent: "cyan" as Accent, icon: Command },
  { name: "Custom Model", note: "Bring your own model", accent: "purple" as Accent, icon: SlidersHorizontal },
];

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function AgentAvatar({
  accent,
  icon: Icon,
  compact = false,
}: {
  accent: Accent;
  icon: LucideIcon;
  compact?: boolean;
}) {
  return (
    <span className={`agent-avatar accent-${accent} ${compact ? "compact" : ""}`}>
      <Icon size={compact ? 14 : 17} strokeWidth={2} />
      <span className="agent-online" />
    </span>
  );
}

function Sidebar({
  open,
  onClose,
  activeNav,
  setActiveNav,
}: {
  open: boolean;
  onClose: () => void;
  activeNav: string;
  setActiveNav: (value: string) => void;
}) {
  return (
    <>
      {open && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="brand">
          <LogoMark />
          <span className="brand-name">AgenticOS</span>
          <span className="version">v2.4.1</span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={activeNav === label ? "active" : ""}
              onClick={() => {
                setActiveNav(label);
                onClose();
              }}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {activeNav === label && <ChevronRight size={14} className="nav-chevron" />}
            </button>
          ))}
        </nav>

        <section className="active-agents-card">
          <header>
            <span>Active Agents</span>
            <small>12 / 24</small>
          </header>
          <div className="agent-list">
            {agents.map((agent) => (
              <button className="agent-row" key={agent.name}>
                <AgentAvatar accent={agent.accent} icon={agent.icon} />
                <span className="agent-copy">
                  <strong>{agent.name}</strong>
                  <small>
                    <i className={`status-dot dot-${agent.accent}`} />
                    {agent.model}
                  </small>
                </span>
                <em className={`text-${agent.accent}`}>{agent.state}</em>
              </button>
            ))}
          </div>
          <button className="text-link">
            View all agents <ChevronRight size={13} />
          </button>
        </section>

        <button className="collapse-nav" aria-label="Collapse navigation">
          <ChevronRight size={16} />
        </button>
      </aside>
    </>
  );
}

function TopBar({
  onMenu,
  notificationOpen,
  setNotificationOpen,
}: {
  onMenu: () => void;
  notificationOpen: boolean;
  setNotificationOpen: (value: boolean) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [project, setProject] = useState("Acme Platform");

  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onMenu} aria-label="Open navigation">
        <Menu size={20} />
      </button>
      <div className="system-status">
        <span className="pulse-dot" />
        <span>
          <small>System Status</small>
          <strong>All Systems Operational</strong>
        </span>
        <ChevronRight size={13} />
      </div>

      <div className="topbar-actions">
        <label className="project-select">
          <Network size={19} />
          <span>
            <small>Project</small>
            <select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Current project">
              <option>Acme Platform</option>
              <option>Atlas Mobile</option>
              <option>Northstar API</option>
            </select>
          </span>
          <ChevronDown size={14} />
        </label>

        <div className={`search-control ${searchOpen ? "search-open" : ""}`}>
          {searchOpen && <input autoFocus placeholder="Search workspace..." aria-label="Search workspace" />}
          <button aria-label={searchOpen ? "Close search" : "Search"} onClick={() => setSearchOpen(!searchOpen)}>
            {searchOpen ? <X size={18} /> : <Search size={19} />}
          </button>
        </div>
        <button className="icon-button desktop-only" aria-label="Integrations">
          <SlidersHorizontal size={19} />
        </button>
        <div className="notification-wrap">
          <button
            className="icon-button"
            aria-label="Notifications"
            aria-expanded={notificationOpen}
            onClick={() => setNotificationOpen(!notificationOpen)}
          >
            <Bell size={19} />
            <span className="notification-dot" />
          </button>
          {notificationOpen && (
            <div className="notification-popover">
              <div>
                <strong>2 new updates</strong>
                <small>Workflow activity</small>
              </div>
              <p><span className="tiny-orb blue" />Auth test suite passed</p>
              <p><span className="tiny-orb amber" />Deploy approval is ready</p>
            </div>
          )}
        </div>
        <button className="user-profile" aria-label="Open user profile">
          <span className="profile-photo">AL</span>
          <span className="profile-online" />
          <ChevronRight size={14} />
        </button>
      </div>
    </header>
  );
}

function Robot({ accent }: { accent: Accent }) {
  return (
    <span className={`robot accent-${accent}`} aria-hidden="true">
      <i className="robot-antenna" />
      <i className="robot-head">
        <b />
        <b />
      </i>
      <i className="robot-body" />
      <i className="robot-shadow" />
    </span>
  );
}

function FloatingTask({
  zone,
}: {
  zone: (typeof zones)[number];
}) {
  if (!zone.task) return null;
  const Icon = zone.icon;
  return (
    <article className={`floating-task task-${zone.id}`}>
      <header>
        <span><Icon size={12} />{zone.task}</span>
        {zone.priority && <em>High</em>}
      </header>
      <p><Bot size={12} />{zone.role}</p>
      <footer>
        <strong className={zone.status === "Completed" ? "completed" : ""}>
          {zone.status === "Completed" ? "✓ " : ""}{zone.status}
        </strong>
        {zone.eta && <span>ETA {zone.eta}</span>}
      </footer>
    </article>
  );
}

function WorkspaceScene() {
  const [selectedZone, setSelectedZone] = useState("engine");

  return (
    <section className="workspace-scene" aria-label="AI agent operation map">
      <div className="scene-atmosphere" />
      <div className="circuit-line line-a" />
      <div className="circuit-line line-b" />
      <div className="circuit-line line-c" />
      <div className="circuit-line line-d" />
      <span className="circuit-node node-a" />
      <span className="circuit-node node-b" />
      <span className="circuit-node node-c" />
      <span className="circuit-node node-d" />

      {zones.map((zone) => {
        const Icon = zone.icon;
        return (
          <button
            key={zone.id}
            className={`workspace-zone zone-${zone.id} accent-${zone.accent} ${selectedZone === zone.id ? "zone-selected" : ""}`}
            onClick={() => setSelectedZone(zone.id)}
            aria-label={`${zone.title}: ${zone.subtitle}`}
          >
            <span className="zone-room">
              <i className="room-floor" />
              <i className="room-wall wall-back" />
              <i className="room-wall wall-side" />
              <i className="room-desk" />
              <i className="room-screen screen-one" />
              <i className="room-screen screen-two" />
              <i className="room-lamp" />
            </span>
            <span className="zone-label">
              <Icon size={12} />
              <span>
                <strong>{zone.title}</strong>
                <small>{zone.subtitle}</small>
              </span>
            </span>
            <Robot accent={zone.accent} />
          </button>
        );
      })}

      <button
        className={`engine-core ${selectedZone === "engine" ? "zone-selected" : ""}`}
        onClick={() => setSelectedZone("engine")}
        aria-label="Workflow Engine: Orchestration and logic"
      >
        <span className="core-rings">
          <i />
          <i />
          <i />
        </span>
        <Robot accent="blue" />
        <span className="engine-label">
          <strong>WORKFLOW ENGINE</strong>
          <small>Orchestration & Logic</small>
        </span>
      </button>

      {zones.map((zone) => <FloatingTask key={`task-${zone.id}`} zone={zone} />)}

      <article className="error-rate-card">
        <small>Error Rate</small>
        <strong>2.48%</strong>
        <span>−12.5%</span>
        <em>vs. last 24h</em>
        <svg viewBox="0 0 100 38" role="img" aria-label="Error rate trend">
          <path d="M2 31 C12 34 13 21 23 22 S36 38 47 17 S61 33 72 23 S87 20 98 5" />
          <circle cx="98" cy="5" r="3" />
        </svg>
      </article>
    </section>
  );
}

function SystemOverview() {
  return (
    <section className="analytics-card system-overview">
      <header>
        <div>
          <h2>System Overview</h2>
          <p>Live distribution</p>
        </div>
        <button aria-label="More system overview options">•••</button>
      </header>
      <div className="overview-body">
        <div className="donut-chart">
          <span>
            <strong>12</strong>
            <small>Active Agents</small>
          </span>
        </div>
        <ul>
          <li><i className="legend-blue" />Planning <strong>2</strong></li>
          <li><i className="legend-green" />Coding <strong>4</strong></li>
          <li><i className="legend-purple" />Testing <strong>2</strong></li>
          <li><i className="legend-amber" />Deploying <strong>1</strong></li>
          <li><i className="legend-orange" />Monitoring <strong>3</strong></li>
        </ul>
      </div>
    </section>
  );
}

function TaskThroughput() {
  return (
    <section className="analytics-card throughput-card">
      <header>
        <div>
          <h2>Task Throughput</h2>
          <p>Last 24 hours</p>
        </div>
        <span className="live-badge">LIVE</span>
      </header>
      <div className="throughput-number">
        <strong>186</strong>
        <span>+14.2%</span>
      </div>
      <div className="line-chart">
        <i className="grid-line one" />
        <i className="grid-line two" />
        <i className="grid-line three" />
        <svg viewBox="0 0 230 76" preserveAspectRatio="none" role="img" aria-label="Task throughput increased over the last 24 hours">
          <defs>
            <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3ca7ff" stopOpacity=".28" />
              <stop offset="100%" stopColor="#3ca7ff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="area" d="M0,58 L12,62 L24,46 L36,52 L49,34 L63,58 L78,43 L92,28 L108,56 L123,33 L137,29 L151,20 L165,26 L180,42 L195,23 L210,18 L220,3 L230,3 L230,76 L0,76 Z" />
          <path className="line" d="M0,58 L12,62 L24,46 L36,52 L49,34 L63,58 L78,43 L92,28 L108,56 L123,33 L137,29 L151,20 L165,26 L180,42 L195,23 L210,18 L220,3 L230,3" />
          <circle cx="220" cy="3" r="3.5" />
        </svg>
      </div>
      <div className="chart-axis"><span>00:00</span><span>12:00</span><span>24:00</span></div>
    </section>
  );
}

function ModelUsage() {
  return (
    <section className="analytics-card model-usage">
      <header>
        <div>
          <h2>Model Usage</h2>
          <p>By Tokens</p>
        </div>
      </header>
      <div className="usage-list">
        {modelUsage.map((model) => (
          <div className="usage-row" key={model.name}>
            <div>
              <span>{model.name}</span>
              <span>{model.percent}%</span>
              <span>{model.tokens}</span>
            </div>
            <i>
              <b style={{ width: `${model.percent * 2.2}%`, background: model.color }} />
            </i>
          </div>
        ))}
      </div>
      <button className="analytics-link">View full analytics <ChevronRight size={13} /></button>
    </section>
  );
}

function WorkflowActivity() {
  return (
    <section className="bottom-card workflow-activity">
      <header>
        <h2>Workflow Activity</h2>
        <span><i />Real-time</span>
      </header>
      <div className="timeline">
        {workflowEvents.map((item, index) => {
          const Icon = item.icon;
          return (
            <div className="timeline-event" key={item.role}>
              <span className={`timeline-icon accent-${item.accent}`}><Icon size={17} /></span>
              <span className="timeline-copy">
                <strong>{item.role}</strong>
                <small>{item.event}</small>
                <em>{item.time}</em>
              </span>
              {index < workflowEvents.length - 1 && <ChevronRight className="timeline-arrow" size={14} />}
            </div>
          );
        })}
      </div>
      <div className="timeline-track">
        {workflowEvents.map((item) => <i key={item.role} className={`dot-${item.accent}`} />)}
      </div>
    </section>
  );
}

function ModelSelection() {
  const [selected, setSelected] = useState("Claude 3.5 Sonnet");
  const [deployed, setDeployed] = useState(false);

  return (
    <section className="bottom-card model-selection">
      <header>
        <div>
          <h2>Select Model for New Agent</h2>
          <p>Choose the best brain for the task</p>
        </div>
        <button
          className={`deploy-agent ${deployed ? "deployed" : ""}`}
          onClick={() => {
            setDeployed(true);
            window.setTimeout(() => setDeployed(false), 1800);
          }}
        >
          {deployed ? "Agent created" : "Create agent"}
        </button>
      </header>
      <div className="model-options">
        {models.map((model) => {
          const Icon = model.icon;
          return (
            <button
              key={model.name}
              className={selected === model.name ? "selected" : ""}
              onClick={() => setSelected(model.name)}
            >
              <span className={`model-icon accent-${model.accent}`}><Icon size={16} /></span>
              <strong>{model.name}</strong>
              <small>{model.note}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeNav, setActiveNav] = useState("Overview");
  const [notificationOpen, setNotificationOpen] = useState(false);

  return (
    <main className="app-shell">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeNav={activeNav}
        setActiveNav={setActiveNav}
      />

      <div className="dashboard">
        <TopBar
          onMenu={() => setSidebarOpen(true)}
          notificationOpen={notificationOpen}
          setNotificationOpen={setNotificationOpen}
        />

        <section className="hero-heading">
          <div>
            <span className="eyebrow"><Sparkles size={13} />Orchestration console</span>
            <h1>{activeNav === "Overview" ? "AI Agent Workspace" : activeNav}</h1>
            <p>
              {activeNav === "Overview"
                ? "Coordinate your agents. Ship better software."
                : `Manage your ${activeNav.toLowerCase()} from one connected workspace.`}
            </p>
          </div>
          <div className="heading-actions">
            <button><GitBranch size={15} />main <ChevronDown size={13} /></button>
            <button className="primary-action"><Bot size={16} />New agent</button>
          </div>
        </section>

        <div className="content-grid">
          <div className="workspace-column">
            <WorkspaceScene />
          </div>
          <aside className="analytics-rail" aria-label="System analytics">
            <SystemOverview />
            <TaskThroughput />
            <ModelUsage />
          </aside>
        </div>

        <div className="bottom-grid">
          <WorkflowActivity />
          <ModelSelection />
        </div>
      </div>
    </main>
  );
}
