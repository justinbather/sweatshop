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

async function issueIdByTicket(ticket: string): Promise<string> {
  const num = Number(ticket.split("-")[1]);
  if (!num) throw new Error(`bad ticket identifier: ${ticket}`);
  const d = await gql(
    `query($team: String!, $num: Float!) { issues(filter: { team: { key: { eq: $team } }, number: { eq: $num } }) { nodes { id } } }`,
    { team: TEAM, num },
  );
  const id = d?.issues?.nodes?.[0]?.id;
  if (!id) throw new Error(`ticket ${ticket} not found`);
  return id;
}

export async function moveTicket(ticket: string, stateName: string): Promise<void> {
  const [id, sid] = await Promise.all([issueIdByTicket(ticket), stateId(stateName)]);
  await gql(`mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`, { id, state: sid });
}

export async function commentTicket(ticket: string, body: string): Promise<void> {
  const id = await issueIdByTicket(ticket);
  await gql(`mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`, { id, body });
}

export async function resolveApproval(issueId: string, decision: "approve" | "reject"): Promise<void> {
  const target = decision === "approve" ? "Creation Queue" : "Rejected";
  const sid = await stateId(target);
  await gql(`mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`, {
    id: issueId, state: sid,
  });
}

// ---- board surface (so the dashboard fully replaces opening Linear) ---------------

let cachedTeamId: string | null = null;
async function teamId(): Promise<string> {
  if (!cachedTeamId) {
    const d = await gql(`query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { id } } }`, { team: TEAM });
    cachedTeamId = d?.teams?.nodes?.[0]?.id;
    if (!cachedTeamId) throw new Error(`team ${TEAM} not found`);
  }
  return cachedTeamId;
}

export async function listTickets(states: string[]) {
  const d = await gql(
    `query($team: String!, $states: [String!]!) {
      issues(first: 50, orderBy: updatedAt,
             filter: { team: { key: { eq: $team } }, state: { name: { in: $states } } }) {
        nodes { id identifier title url updatedAt description state { name }
                comments { nodes { body createdAt } } } } }`,
    { team: TEAM, states },
  );
  return (d?.issues?.nodes || []).map((n: any) => ({
    id: n.id, identifier: n.identifier, title: n.title, url: n.url,
    updatedAt: n.updatedAt, state: n.state?.name || "", description: n.description || "",
    comments: [...(n.comments?.nodes || [])]
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-4)
      .map((c: any) => ({ body: c.body, createdAt: c.createdAt })),
  }));
}

export async function getTicketByIdentifier(identifier: string) {
  const num = Number(identifier.split("-")[1]);
  if (!num) throw new Error(`bad ticket identifier: ${identifier}`);
  const d = await gql(
    `query($team: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $team } }, number: { eq: $num } }) {
        nodes { id identifier title url state { name } description
                comments { nodes { body createdAt } } } } }`,
    { team: TEAM, num },
  );
  const n = d?.issues?.nodes?.[0];
  if (!n) throw new Error(`ticket ${identifier} not found`);
  return {
    id: n.id, identifier: n.identifier, title: n.title, url: n.url,
    state: n.state?.name || "", description: n.description || "",
    comments: [...(n.comments?.nodes || [])]
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((c: any) => ({ body: c.body, createdAt: c.createdAt })),
  };
}

export async function createTicket(title: string, description: string, stateName: string) {
  const [tid, sid] = await Promise.all([teamId(), stateId(stateName)]);
  const d = await gql(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier url } } }`,
    { input: { teamId: tid, title, description, stateId: sid } },
  );
  const issue = d?.issueCreate?.issue;
  if (!issue) throw new Error("issueCreate failed");
  return issue as { id: string; identifier: string; url: string };
}

export async function moveIssueById(id: string, stateName: string): Promise<void> {
  const sid = await stateId(stateName);
  await gql(`mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`, { id, state: sid });
}

export async function commentIssueById(id: string, body: string): Promise<void> {
  await gql(`mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`, { id, body });
}

/** Upload bytes into Linear's file storage; returns the permanent asset URL. */
export async function uploadToLinear(filename: string, contentType: string, data: Buffer): Promise<string> {
  const d = await gql(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success uploadFile { uploadUrl assetUrl headers { key value } } } }`,
    { contentType, filename, size: data.length },
  );
  const uf = d?.fileUpload?.uploadFile;
  if (!uf) throw new Error("fileUpload failed");
  const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000" };
  for (const h of uf.headers || []) headers[h.key] = h.value;
  const res = await fetch(uf.uploadUrl, { method: "PUT", headers, body: new Uint8Array(data) });
  if (!res.ok) throw new Error(`asset PUT failed: ${res.status}`);
  return uf.assetUrl;
}

/** Fetch a Linear-hosted asset with auth (browser <img> tags can't send the key). */
export async function fetchLinearAsset(url: string): Promise<{ contentType: string; data: Buffer }> {
  const u = new URL(url);
  if (u.hostname !== "uploads.linear.app") throw new Error("only uploads.linear.app assets are proxied");
  const key = await linearKey();
  let res = await fetch(url, { headers: key ? { Authorization: key } : {} });
  if (!res.ok) res = await fetch(url); // signed URLs work unauthenticated
  if (!res.ok) throw new Error(`asset fetch → ${res.status}`);
  return { contentType: res.headers.get("content-type") || "image/png", data: Buffer.from(await res.arrayBuffer()) };
}
