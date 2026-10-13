import { McpEditor } from "@/components/mcp-editor";

export default async function EditMcpPage({ params }: { params: Promise<{ id: string }> }) { return <McpEditor id={(await params).id} />; }
