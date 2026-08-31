import { describe, expect, it } from "vite-plus/test";
import {
  PAGINATION_LOOP_ITEM_ORDINAL_TOKEN,
  inferPaginationLoopSelectorCandidates,
} from "./pagination-loop.js";

describe("inferPaginationLoopSelectorCandidates", () => {
  it("returns one explicit candidate for each nth-of-type segment", () => {
    const candidates = inferPaginationLoopSelectorCandidates(
      "body > main:nth-of-type(2) > ul.results > li.result:nth-of-type(3) > a",
    );

    expect(candidates).toEqual([
      {
        candidateIndex: 0,
        sourceOrdinal: 2,
        listSelector: "body > main",
        sourceItemSelector: "body > main:nth-of-type(2)",
        itemSelectorTemplate: `body > main:nth-of-type(${PAGINATION_LOOP_ITEM_ORDINAL_TOKEN})`,
      },
      {
        candidateIndex: 1,
        sourceOrdinal: 3,
        listSelector: "body > main:nth-of-type(2) > ul.results > li.result",
        sourceItemSelector: "body > main:nth-of-type(2) > ul.results > li.result:nth-of-type(3)",
        itemSelectorTemplate: `body > main:nth-of-type(2) > ul.results > li.result:nth-of-type(${PAGINATION_LOOP_ITEM_ORDINAL_TOKEN})`,
      },
    ]);
  });

  it("returns no candidate when the recorded selector has no repeated structural segment", () => {
    expect(inferPaginationLoopSelectorCandidates("#first-result")).toEqual([]);
    expect(inferPaginationLoopSelectorCandidates("body > main > a.result-link")).toEqual([]);
    expect(inferPaginationLoopSelectorCandidates("   ")).toEqual([]);
  });

  it("ignores invalid ordinals without renumbering gaps in the candidate list", () => {
    expect(
      inferPaginationLoopSelectorCandidates("body:nth-of-type(0) > ul > li:nth-of-type(4)"),
    ).toEqual([
      {
        candidateIndex: 0,
        sourceOrdinal: 4,
        listSelector: "body:nth-of-type(0) > ul > li",
        sourceItemSelector: "body:nth-of-type(0) > ul > li:nth-of-type(4)",
        itemSelectorTemplate: `body:nth-of-type(0) > ul > li:nth-of-type(${PAGINATION_LOOP_ITEM_ORDINAL_TOKEN})`,
      },
    ]);
  });
});
