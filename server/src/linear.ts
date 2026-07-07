import { getConfigValue } from "./db.js";

/** Raw Linear GraphQL for the dashboard's read/act surface (counts, approvals). */
const TEAM = process.env.LINEAR_TEAM || "CON";

async function linearKey(): Promise<string | null> {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const secrets = await getConfigValue<Record<string, string>>("secrets");
  return secrets?.LINEAR_API_KEY || null;
}

async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const key = await linearKey();
  if (!key) throw new Error("no LINEAR_API_KEY");
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

export async function pipelineCounts(): Promise<Record<string, number>> {
  const d = await gql(
    `query($team: String!) { issues(first: 200, filter: { team: { key: { eq: $team } }, state: { type: { nin: ["completed","canceled"] } } }) { nodes { state { name } } } }`,
    { team: TEAM },
  );
  const counts: Record<string, number> = {};
  for (const n of d?.issues?.nodes || []) {
    const s = n.state?.name;
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

let stateIds: Map<string, string> | null = null;
async function stateId(name: string): Promise<string> {
  if (!stateIds) {
    const d = await gql(`query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { states { nodes { id name } } } } }`, { team: TEAM });
    stateIds = new Map((d?.teams?.nodes?.[0]?.states?.nodes || []).map((s: any) => [s.name, s.id]));
  }
  const id = stateIds.get(name);
  if (!id) throw new Error(`state "${name}" not found on team ${TEAM}`);
  return id;
}

export async function listApprovals() {
  const d = await gql(
    `query($team: String!) { issues(filter: { team: { key: { eq: $team } }, state: { name: { eq: "Needs Approval" } } }) {
       nodes { id identifier title url comments { nodes { body createdAt } } } } }`,
    { team: TEAM },
  );
  return (d?.issues?.nodes || []).map((iss: any) => {
    const comments = [...(iss.comments?.nodes || [])].sort(
      (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const pick = comments.find((c: any) => (c.body || "").includes("🎬")) || comments[0];
    return { id: iss.id, identifier: iss.identifier, title: iss.title, url: iss.url, concepts: pick ? pick.body : "" };
  });
}

export async function resolveApproval(issueId: string, decision: "approve" | "reject"): Promise<void> {
  const target = decision === "approve" ? "Creation Queue" : "Rejected";
  const sid = await stateId(target);
  await gql(`mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`, {
    id: issueId, state: sid,
  });
}
