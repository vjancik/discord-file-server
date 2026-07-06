import { getTusServer } from "@/server/uploads/tus";

// `path` in the tus server config must match this route's mount point.
const handle = (req: Request) => getTusServer().handleWeb(req);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const HEAD = handle;
