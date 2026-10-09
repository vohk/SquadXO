declare module 'ssh2-sftp-client' {
  interface ConnectionOptions {
    readonly host: string;
    readonly port?: number;
    readonly username: string;
    readonly password?: string;
    readonly privateKey?: string | Buffer;
  }

  interface FileStats {
    readonly size: number;
  }

  interface GetOptions {
    readonly readStreamOptions?: {
      readonly start?: number;
      readonly end?: number;
    };
  }

  export default class SftpClient {
    connect(options: ConnectionOptions): Promise<void>;
    end(): Promise<void>;
    stat(remotePath: string): Promise<FileStats>;
    get(remotePath: string, destination?: undefined, options?: GetOptions): Promise<Buffer>;
  }
}
