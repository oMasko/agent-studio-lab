import type { ReactNode } from "react";
import Link from "next/link";

import { AgentSettingsMenu, type ManagementSection } from "@/components/agent-settings-menu";

type ManagementHeaderProps = {
  current: ManagementSection;
  eyebrow: string;
  title: string;
  description?: string;
  backHref?: string;
  actions?: ReactNode;
  actionsClassName?: string;
};

export function ManagementHeader({
  current,
  eyebrow,
  title,
  description,
  backHref = "/",
  actions,
  actionsClassName = "",
}: ManagementHeaderProps) {
  return <header className="management-header">
    <div className="management-title">
      <Link href={backHref} className="back-button" aria-label="返回">←</Link>
      <div><span>{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>
    </div>
    <div className="management-header-tools">
      <AgentSettingsMenu current={current} />
      {actions && <div className={`management-page-actions ${actionsClassName}`.trim()}>{actions}</div>}
    </div>
  </header>;
}
