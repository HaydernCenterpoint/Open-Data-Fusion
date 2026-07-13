import { Activity, ChevronDown, Layers3, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { PlatformContext, PlatformProject, PlatformTenant } from "../types";
import type { PlatformBootstrapState } from "./PlatformWorkspaces";

interface ProjectSwitcherProps {
  context: PlatformContext | null;
  tenants: PlatformTenant[];
  projects: PlatformProject[];
  selectedTenantId: string;
  state: PlatformBootstrapState;
  variant?: "topbar" | "canvas";
  onTenantChange: (tenantId: string) => void;
  onProjectChange: (projectId: string) => void;
  onRetry: () => void;
}

export function ProjectSwitcher({
  context,
  tenants,
  projects,
  selectedTenantId,
  state,
  variant = "topbar",
  onTenantChange,
  onProjectChange,
  onRetry,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tenantSelectRef = useRef<HTMLSelectElement | null>(null);
  const menuId = useId();
  const tenant = tenants.find((item) => item.id === (context?.tenantId ?? selectedTenantId));
  const project = projects.find((item) => item.id === context?.projectId);
  const tenantName = tenant?.name ?? context?.tenantId ?? selectedTenantId;
  const projectName = project?.name ?? context?.projectId;
  const scopeLabel = projectName
    ? `Change project: ${projectName}${tenantName ? ` in ${tenantName}` : ""}`
    : "Choose project";
  const isLoading = state.status === "loading";

  function closeSwitcher(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = window.setTimeout(() => tenantSelectRef.current?.focus(), 0);
    const closeOnPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) closeSwitcher();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSwitcher(true);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`project-switcher project-switcher--${variant}`} ref={containerRef}>
      <button
        className="project-switcher__trigger"
        ref={triggerRef}
        type="button"
        aria-label={scopeLabel}
        aria-haspopup="dialog"
        aria-controls={menuId}
        aria-expanded={open}
        title={scopeLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <Layers3 size={15} aria-hidden="true" />
        <span className="project-switcher__tenant">{tenantName ?? "Project"}</span>
        <strong>{projectName ?? "Loading project"}</strong>
        <ChevronDown className="project-switcher__chevron" size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="project-switcher__menu" id={menuId} role="dialog" aria-label="Project switcher">
          <header>
            <div>
              <span>Project context</span>
              <strong>Choose an accessible scope</strong>
            </div>
            <button type="button" aria-label="Close project switcher" onClick={() => closeSwitcher(true)}><X size={15} /></button>
          </header>
          <label>
            <span>Tenant</span>
            <select
              aria-label="Project tenant"
              ref={tenantSelectRef}
              value={selectedTenantId}
              disabled={isLoading || tenants.length === 0}
              onChange={(event) => {
                if (event.target.value && event.target.value !== selectedTenantId) onTenantChange(event.target.value);
              }}
            >
              {tenants.length === 0 ? <option value="">No tenant</option> : tenants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span>Project</span>
            <select
              aria-label="Project"
              value={context?.projectId ?? ""}
              disabled={isLoading || projects.length === 0}
              onChange={(event) => {
                if (event.target.value && event.target.value !== context?.projectId) {
                  onProjectChange(event.target.value);
                  closeSwitcher(true);
                }
              }}
            >
              {projects.length === 0 ? <option value="">No project</option> : projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div className={`project-switcher__status is-${state.status}`} role={["unauthorized", "forbidden", "degraded"].includes(state.status) ? "alert" : "status"}>
            {isLoading ? <Activity className="spin" size={13} aria-hidden="true" /> : null}
            <span>{state.message}</span>
          </div>
          {state.status !== "ready" && !isLoading ? <button className="project-switcher__retry" type="button" onClick={onRetry}><RefreshCw size={14} /> Retry discovery</button> : null}
        </div>
      ) : null}
    </div>
  );
}
