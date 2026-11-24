import { expect, test } from "bun:test"
import { cleanTitle } from "../../src/titles/title.ts"

test("cleanTitle strips markdown and a Title label", () => {
  expect(cleanTitle("**Title:** Reading the parser")).toBe("Reading the parser")
  expect(cleanTitle("Title: Fix the build")).toBe("Fix the build")
  expect(cleanTitle("# Session title: \"Parser repair\"")).toBe("Parser repair")
  expect(cleanTitle("`Fix` the _parser_ tests.\nmore")).toBe("Fix the parser tests")
  expect(cleanTitle("Title")).toBe("Title")
  expect(cleanTitle("Titles for posts")).toBe("Titles for posts")
})
