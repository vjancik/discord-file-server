import { describe, expect, test } from "bun:test";
import { GuildGate } from "./guild-gate";
import type { DiscordGuildGateway } from "./guild-gateway";

function fakeGateway(guildIds: string[] | Error): DiscordGuildGateway {
  return {
    async listGuildIds() {
      if (guildIds instanceof Error) throw guildIds;
      return guildIds;
    },
  };
}

const ALLOWED = ["guild-a", "guild-b"];

describe("GuildGate", () => {
  test("allows a member of an allowed guild", async () => {
    const gate = new GuildGate(fakeGateway(["other", "guild-b"]), ALLOWED);
    expect(await gate.isAllowed("token")).toBe(true);
  });

  test("denies a user in no allowed guild", async () => {
    const gate = new GuildGate(fakeGateway(["other", "another"]), ALLOWED);
    expect(await gate.isAllowed("token")).toBe(false);
  });

  test("denies a user with no guilds at all", async () => {
    const gate = new GuildGate(fakeGateway([]), ALLOWED);
    expect(await gate.isAllowed("token")).toBe(false);
  });

  test("denies when there is no access token", async () => {
    const gate = new GuildGate(fakeGateway(["guild-a"]), ALLOWED);
    expect(await gate.isAllowed(null)).toBe(false);
    expect(await gate.isAllowed(undefined)).toBe(false);
  });

  test("fails closed when the Discord API errors", async () => {
    const gate = new GuildGate(fakeGateway(new Error("429")), ALLOWED);
    expect(await gate.isAllowed("token")).toBe(false);
  });
});
