import Link from "next/link";
import { ManagementHeader } from "@/components/management-header";
import styles from "./page.module.css";

export default function ExperimentsPage() {
  return <main className="management-page">
    <ManagementHeader current="experiments" eyebrow="EXPERIMENTS" title="实验功能" description="用于探索和验证的能力，独立于日常 Agent 配置，按需体验。" />
    <section className={styles.catalog} aria-label="实验功能列表">
      <article className={styles.card}>
        <span className={styles.badge}>实验中</span>
        <h2>Agent 讨论室</h2>
        <p>邀请独立 Agent 围绕同一议题交流，探索多角色协作是否能带来额外价值。</p>
        <p className={styles.note}>现有讨论记录和参会方式保持不变。暂缓功能扩展，仍可继续试用。</p>
        <Link href="/discussions" className={styles.entry}>进入讨论室 <span aria-hidden="true">→</span></Link>
      </article>
    </section>
  </main>;
}
