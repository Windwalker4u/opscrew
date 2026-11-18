/**
 * The web filter's renders: the script on the server and the `web-filter` step's scripts, pinned
 * by snapshot so a change to them shows in review (servers already set up keep their hashes).
 */
import { describe, expect, it } from "vitest";
import { scriptsFor } from "./__fixtures__/helpers";
import { webFilterFileHashes, webFilterScript } from "./web-filter";

const IPV4 = ["103.21.244.0/22", "173.245.48.0/20"];

describe("the web filter's renders", () => {
  it("IPv4 only: the script and its files keep their hashes", () => {
    expect(webFilterFileHashes({ ipv4: IPV4 })).toEqual({
      script: "7041f46b3e89fd34e397c4bfda5053ef8c22c52a80f69a6919c0cc96405a962a",
      unit: "5ba0c4e7fc47da79c43dd085a0191a240f49e8b3499c4ca253bad677b4893782",
      dropIn: "97c2a952b4f120ec2d2868592b8fc4fc5e02ce2bc7109fff45f5ce1d4df9ef0a",
    });
    expect(webFilterScript({ ipv4: IPV4 })).toMatchSnapshot();
  });

  it("IPv4 only: the step's scripts match their snapshot", () => {
    expect(scriptsFor({ id: "web-filter", params: { ipv4: IPV4.join(" ") } })).toMatchSnapshot();
  });

  it("the removal's scripts match their snapshot", () => {
    expect(scriptsFor({ id: "web-filter", params: { remove: true } })).toMatchSnapshot();
  });
});
