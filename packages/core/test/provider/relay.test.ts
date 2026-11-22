import { expect, test } from "bun:test"
import { ACCESS_TOKEN_FILE_ENV } from "../../src/auth/handed-in.ts"
import { parseConfigFile } from "../../src/config/schema.ts"
import { MODEL_ALLOWED_ORIGIN_ENV, MODEL_BASE_URL_ENV, modelEndpoint } from "../../src/provider/relay.ts"

const endpoint = (base: string, origin?: string) => modelEndpoint({ [ACCESS_TOKEN_FILE_ENV]: "/synthetic/token", [MODEL_BASE_URL_ENV]: base, [MODEL_ALLOWED_ORIGIN_ENV]: origin }, true)

test("the host can name a loopback relay or one exact origin", () => {
  for (const file of [undefined, ""])
    expect(() => modelEndpoint({ [MODEL_BASE_URL_ENV]: "http://localhost", [ACCESS_TOKEN_FILE_ENV]: file }, true)).toThrow(ACCESS_TOKEN_FILE_ENV)
  expect(modelEndpoint({}, false)).toEqual({})
  for (const key of ["modelBaseUrl", MODEL_BASE_URL_ENV, MODEL_ALLOWED_ORIGIN_ENV])
    expect(() => parseConfigFile(JSON.stringify({ [key]: "http://localhost" }), "project.json", "project")).toThrow("unknown key")
  for (const base of ["http://127.0.0.1:4050/v1", "http://[::1]/v1", "https://localhost/v1"])
    expect(endpoint(base + "/")).toEqual({ baseUrl: base })
  expect(endpoint("https://relay.example:8443/v1", "https://relay.example:8443")).toEqual({ baseUrl: "https://relay.example:8443/v1" })
  for (const base of ["https://relay.example:8443", "http://relay.example", "https://relay.example.evil.test", "file:///tmp", "http://localhost.example", "http://localhost@other.test", "http://u:p@localhost", "http://localhost/?key=value", "http://localhost/#fragment", "invalid"])
    expect(() => endpoint(base, "https://relay.example")).toThrow()
  expect(() => modelEndpoint({ [MODEL_BASE_URL_ENV]: "http://localhost" }, false)).toThrow("--no-env-file")
})
