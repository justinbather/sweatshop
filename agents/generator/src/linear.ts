import { readFileSync } from "fs";
import { basename } from "path";
import { LinearClient, IssueRelationType, type Issue } from "@linear/sdk";
import type { Brief } from "./schema";

/**
 * Thin wrapper over the Linear API for the board handoff. Resolves the team and
 * its workflow states up front (by name), then exposes queue / move / comment.
 */
export class Board {
  private client: LinearClient;
  private teamId = "";
  private statesByName = new Map<string, string>(); // name -> stateId

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  /** Resolve the team by its key (e.g. "CON") and cache its workflow states. */
  async init(teamKey: string): Promise<void> {
    const teams = await this.client.teams({ filter: { key: { eq: teamKey } } });
    const team = teams.nodes[0];
    if (!team) throw new Error(`No Linear team with key "${teamKey}".`);
    this.teamId = team.id;

    const states = await team.states();
    for (const s of states.nodes) this.statesByName.set(s.name, s.id);
  }

  stateNames(): string[] {
    return [...this.statesByName.keys()];
  }

  private stateId(name: string): string {
    const id = this.statesByName.get(name);
    if (!id) {
      throw new Error(
        `State "${name}" not found on this board. Available: ${this.stateNames().join(" · ")}`,
      );
    }
    return id;
  }

  /** Issues currently sitting in the given workflow state. */
  async queue(stateName: string): Promise<Issue[]> {
    const issues = await this.client.issues({
      filter: {
        team: { id: { eq: this.teamId } },
        state: { name: { eq: stateName } },
      },
    });
    return issues.nodes;
  }

  async move(issueId: string, stateName: string): Promise<void> {
    await this.client.updateIssue(issueId, { stateId: this.stateId(stateName) });
  }

  async setDescription(issueId: string, description: string): Promise<void> {
    await this.client.updateIssue(issueId, { description });
  }

  /** Fetch an issue by its identifier (e.g. "CON-42"). */
  async issueByIdentifier(identifier: string): Promise<Issue | null> {
    const num = Number(identifier.split("-")[1]);
    if (!num) return null;
    const issues = await this.client.issues({
      filter: { team: { id: { eq: this.teamId } }, number: { eq: num } },
    });
    return issues.nodes[0] ?? null;
  }

  /** Create a sub-issue (variation) under a parent, placed directly in `stateName`. */
  async createVariation(parentId: string, title: string, stateName: string, description?: string): Promise<string> {
    const payload = await this.client.createIssue({
      teamId: this.teamId,
      parentId,
      title,
      stateId: this.stateId(stateName),
      description,
    });
    const issue = await payload.issue;
    if (!issue) throw new Error("Failed to create variation sub-issue");
    return issue.id;
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId, body });
  }

  /** Create a top-level issue in `stateName`; returns its ids for linking. */
  async createIssue(title: string, stateName: string, description?: string): Promise<{ id: string; identifier: string; url: string }> {
    const payload = await this.client.createIssue({
      teamId: this.teamId,
      title,
      stateId: this.stateId(stateName),
      description,
    });
    const issue = await payload.issue;
    if (!issue) throw new Error("Failed to create issue");
    return { id: issue.id, identifier: issue.identifier, url: issue.url };
  }

  /** Add a "related" relation between two issues (shows in both tickets). */
  async relate(issueId: string, relatedIssueId: string): Promise<void> {
    await this.client.createIssueRelation({ issueId, relatedIssueId, type: IssueRelationType.Related });
  }

  /**
   * Upload a local file to Linear's storage and return its permanent asset URL
   * (embed as `![](url)` in a description/comment to render it inline).
   */
  async uploadFile(filePath: string, contentType: string): Promise<string> {
    return this.uploadBuffer(basename(filePath), contentType, readFileSync(filePath));
  }

  /** Upload in-memory bytes to Linear's storage (assets may live in S3, not on disk). */
  async uploadBuffer(filename: string, contentType: string, data: Buffer): Promise<string> {
    const payload = await this.client.fileUpload(contentType, filename, data.length);
    const uf = payload.uploadFile;
    if (!uf) throw new Error("fileUpload returned no uploadFile");
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    };
    for (const h of uf.headers) headers[h.key] = h.value;
    const res = await fetch(uf.uploadUrl, { method: "PUT", headers, body: new Uint8Array(data) });
    if (!res.ok) throw new Error(`upload PUT failed: ${res.status}`);
    return uf.assetUrl;
  }
}

/** Map a Linear issue onto a generation Brief. */
export function issueToBrief(issue: Issue, count: number): Brief {
  return {
    title: issue.title,
    details: issue.description ?? undefined,
    count,
  };
}
