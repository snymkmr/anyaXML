declare module "sax" {
  interface Tag {
    name: string;
    attributes: Record<string, string>;
  }

  interface Parser {
    onopentag?: (tag: Tag) => void;
    onclosetag?: (name: string) => void;
    ontext?: (text: string) => void;
    oncdata?: (text: string) => void;
    onerror?: (error: Error) => void;
    onend?: () => void;
    write(chunk: string): Parser;
    close(): Parser;
  }

  function parser(strict: boolean, options?: { trim?: boolean; normalize?: boolean }): Parser;
}
