declare module 'numfmt' {
  export function isDateFormat(pattern: string): boolean
  export function format(pattern: string, value: number | string | boolean, options?: { leap1900?: boolean }): string
}
declare module 'papaparse' {
  interface Result {
    data: string[][]
    errors: Array<{ code: string }>
    meta: { delimiter: string; cursor: number }
  }
  interface Parser {
    abort(): void
  }
  export function parse(
    text: string,
    options: {
      delimiter?: string
      skipEmptyLines?: boolean
      dynamicTyping?: false
      step?: (result: { data: string[]; errors: Array<{ code: string }> }, parser: Parser) => void
    },
  ): Result
}
