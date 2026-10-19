import {
  CodeXml,
  Container,
  Database,
  FolderCode,
  GitBranch,
  Globe,
  Package,
  Terminal,
} from "lucide-react";
import { localIconNames, type LocalIconKind } from "../shared/workspace-style";
import codex from "./assets/local/codex.svg";
import claude from "./assets/local/claude.svg";
import gemini from "./assets/local/gemini.svg";
import copilot from "./assets/local/copilot.svg";
import cursor from "./assets/local/cursor.svg";
import ollama from "./assets/local/ollama.svg";
import opencode from "./assets/local/opencode.svg";
import cline from "./assets/local/cline.svg";

import chatgpt from "./assets/local/chatgpt.svg";
import deepseek from "./assets/local/deepseek.svg";
import grok from "./assets/local/grok.svg";
import perplexity from "./assets/local/perplexity.svg";
import qwen from "./assets/local/qwen.svg";
import huggingface from "./assets/local/huggingface.svg";
import lmstudio from "./assets/local/lmstudio.svg";
import windsurf from "./assets/local/windsurf.svg";
import github from "./assets/local/github.svg";
import gitlab from "./assets/local/gitlab.svg";
import vscode from "./assets/local/vscode.svg";
import intellij from "./assets/local/intellij.svg";
import neovim from "./assets/local/neovim.svg";
import docker from "./assets/local/docker.svg";
import kubernetes from "./assets/local/kubernetes.svg";
import postman from "./assets/local/postman.svg";
import jenkins from "./assets/local/jenkins.svg";
import terraform from "./assets/local/terraform.svg";
import vercel from "./assets/local/vercel.svg";
import figma from "./assets/local/figma.svg";
import python from "./assets/local/python.svg";
import javascript from "./assets/local/javascript.svg";
import typescript from "./assets/local/typescript.svg";
import nodejs from "./assets/local/nodejs.svg";
import react from "./assets/local/react.svg";
import vuejs from "./assets/local/vuejs.svg";
import nextjs from "./assets/local/nextjs.svg";
import go from "./assets/local/go.svg";
import rust from "./assets/local/rust.svg";
import java from "./assets/local/java.svg";
import kotlin from "./assets/local/kotlin.svg";
import swift from "./assets/local/swift.svg";
import postgresql from "./assets/local/postgresql.svg";
import mysql from "./assets/local/mysql.svg";
import sqlite from "./assets/local/sqlite.svg";
import redis from "./assets/local/redis.svg";
import mongodb from "./assets/local/mongodb.svg";
import supabase from "./assets/local/supabase.svg";
import firebase from "./assets/local/firebase.svg";
import nginx from "./assets/local/nginx.svg";

const logos = {
  chatgpt,
  deepseek,
  grok,
  perplexity,
  qwen,
  huggingface,
  lmstudio,
  windsurf,
  github,
  gitlab,
  vscode,
  intellij,
  neovim,
  docker,
  kubernetes,
  postman,
  jenkins,
  terraform,
  vercel,
  figma,
  python,
  javascript,
  typescript,
  nodejs,
  react,
  vuejs,
  nextjs,
  go,
  rust,
  java,
  kotlin,
  swift,
  postgresql,
  mysql,
  sqlite,
  redis,
  mongodb,
  supabase,
  firebase,
  nginx,

  codex,
  claude,
  gemini,
  copilot,
  cursor,
  ollama,
  opencode,
  cline,
} satisfies Record<Exclude<LocalIconKind, keyof typeof symbols>, string>;
const symbols = {
  project: FolderCode,
  code: CodeXml,
  git: GitBranch,
  container: Container,
  database: Database,
  browser: Globe,
  package: Package,
};

export function LocalIcon({ kind }: { kind: LocalIconKind | "terminal" }) {
  if (kind === "terminal")
    return <Terminal size={22} aria-label="로컬 터미널" />;
  const logo = kind in logos ? logos[kind as keyof typeof logos] : undefined;
  const Symbol =
    kind in symbols ? symbols[kind as keyof typeof symbols] : undefined;
  return (
    <span
      className={`local-icon ${kind} ${logo ? "brand" : "symbol"}`}
      role="img"
      aria-label={localIconNames[kind]}
    >
      {logo ? (
        <img src={logo} alt="" aria-hidden="true" draggable={false} />
      ) : Symbol ? (
        <Symbol size={17} aria-hidden="true" />
      ) : null}
    </span>
  );
}
