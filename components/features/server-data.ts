import { notFound } from "next/navigation";

import { AppError } from "@/lib/services/errors";
import { getProject, getProjectBundle } from "@/lib/services/projects";
import { getSource } from "@/lib/services/sources";

import { asBundle, asProject, asSourceDetail } from "./model";

function handleNotFound(error: unknown): never {
  if (error instanceof AppError && error.status === 404) {
    notFound();
  }
  throw error;
}

export async function loadProject(projectId: string) {
  try {
    return asProject(await getProject(projectId));
  } catch (error) {
    return handleNotFound(error);
  }
}

export async function loadProjectBundle(projectId: string) {
  try {
    return asBundle(await getProjectBundle(projectId));
  } catch (error) {
    return handleNotFound(error);
  }
}

export async function loadSource(sourceId: string) {
  try {
    return asSourceDetail(await getSource(sourceId));
  } catch (error) {
    return handleNotFound(error);
  }
}
