import { describe, expect, it } from "vitest";
import { detectProject } from "./detect";
import { makeTree, removeTree } from "./test-helpers";
import { dockerfileWorkdir, fileCapabilityNote } from "./workdir";

describe("dockerfileWorkdir", () => {
  it("reads the last WORKDIR of the last stage, resolving relative ones", () => {
    const text = [
      "FROM node:24 AS build",
      "WORKDIR /build",
      "RUN npm ci",
      "",
      "# The runtime stage.",
      "FROM node:24-slim",
      "WORKDIR /srv",
      "WORKDIR app/",
      "COPY --from=build /build ./",
      'CMD ["node", "server.js"]',
    ].join("\n");
    expect(dockerfileWorkdir(text)).toBe("/srv/app");
    expect(dockerfileWorkdir('FROM python:3.13\nworkdir "/opt/app"\n')).toBe("/opt/app");
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR /a\nWORKDIR ../b\n")).toBe("/b");
  });

  it("is unknown without a WORKDIR in the last stage, a relative one alone, or a variable", () => {
    expect(dockerfileWorkdir("FROM node:24 AS build\nWORKDIR /app\nFROM nginx\n")).toBeUndefined();
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR app\n")).toBeUndefined();
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR $APP_HOME\n")).toBeUndefined();
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR /srv\nWORKDIR $DIR/app\n")).toBeUndefined();
    // A later absolute WORKDIR is known again.
    expect(dockerfileWorkdir("FROM node:24\nWORKDIR $APP\nWORKDIR /app\n")).toBe("/app");
  });

  it("is in the facts of an app with its own Dockerfile", async () => {
    const root = await makeTree(
      {
        "package.json": JSON.stringify({ name: "api", dependencies: { express: "^5.0.0" } }),
        Dockerfile: "FROM node:24-alpine\nWORKDIR /usr/src/app\nCOPY . .\nCMD node server.js\n",
      },
      "workdir",
    );
    try {
      expect((await detectProject(root)).build.workdir).toBe("/usr/src/app");
    } finally {
      await removeTree(root);
    }
  });
});

describe("fileCapabilityNote", () => {
  it("warns of a FrankenPHP or Caddy base image, named with the binary and how to drop it", () => {
    const franken = fileCapabilityNote(
      [
        "FROM composer:2 AS vendor",
        "RUN composer install",
        `FROM dunglas/frankenphp:1-php8.4-bookworm@sha256:${"a".repeat(64)}`,
        "COPY --from=vendor /src /app",
      ].join("\n"),
      "Dockerfile",
    );
    expect(franken).toContain("Dockerfile builds on dunglas/frankenphp");
    expect(franken).toContain("cap_net_bind_service");
    expect(franken).toContain("cap_drop: ALL");
    expect(franken).toContain("`RUN setcap -r /usr/local/bin/frankenphp`");
    expect(franken).toContain(
      "`RUN cp /usr/local/bin/frankenphp /tmp/frankenphp && mv /tmp/frankenphp /usr/local/bin/frankenphp`",
    );
    // Through a stage alias, with a platform flag and a registry.
    const caddy = fileCapabilityNote(
      "FROM --platform=$BUILDPLATFORM docker.io/library/caddy:2-alpine AS web\nFROM web\n",
      "docker/Dockerfile",
    );
    expect(caddy).toContain("docker/Dockerfile builds on docker.io/library/caddy");
    expect(caddy).toContain("`RUN setcap -r /usr/bin/caddy`");
  });

  it("says nothing when the Dockerfile drops the capability, or builds on another image", () => {
    const base = "FROM dunglas/frankenphp:1-php8.4\n";
    expect(
      fileCapabilityNote(`${base}RUN setcap -r /usr/local/bin/frankenphp\n`, "Dockerfile"),
    ).toBeUndefined();
    expect(
      fileCapabilityNote(
        `${base}RUN cp /usr/local/bin/frankenphp /tmp/frankenphp \\\n  && mv /tmp/frankenphp /usr/local/bin/frankenphp\n`,
        "Dockerfile",
      ),
    ).toBeUndefined();
    // Only the last stage runs: a Caddy build stage is not the app's image.
    expect(
      fileCapabilityNote(
        "FROM caddy:2 AS files\nFROM php:8.4-cli\nCOPY --from=files /srv /srv\n",
        "Dockerfile",
      ),
    ).toBeUndefined();
    expect(fileCapabilityNote("FROM caddy-builder:2\n", "Dockerfile")).toBeUndefined();
  });

  it("is among the notes of an app with its own Dockerfile", async () => {
    const root = await makeTree(
      {
        "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
        "public/index.php": "<?php\n",
        Dockerfile: "FROM dunglas/frankenphp:1-php8.4\nWORKDIR /app\nEXPOSE 8080\n",
      },
      "capability",
    );
    try {
      const notes = (await detectProject(root)).notes ?? [];
      expect(notes.filter((note) => note.includes("cap_net_bind_service"))).toHaveLength(1);
    } finally {
      await removeTree(root);
    }
  });
});
