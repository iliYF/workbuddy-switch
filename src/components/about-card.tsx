import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAccountsStore } from "@/stores/accounts";
import { friendlyVersion } from "@/lib/version";

// 原作者及项目信息
const GITHUB_UPSTREAM_OWNER = "changexbc";
const GITHUB_UPSTREAM_REPO = "workbuddy-switch";
const GITHUB_UPSTREAM_URL = `https://github.com/${GITHUB_UPSTREAM_OWNER}/${GITHUB_UPSTREAM_REPO}`;

// 更新源作者及项目信息
const GITHUB_UPDATE_OWNER = "iliYF";
const GITHUB_UPDATE_REPO = "xBuddy-Switch";
const UPDATE_SOURCE_URL = `https://github.com/${GITHUB_UPDATE_OWNER}/${GITHUB_UPDATE_REPO}`;

export function AboutCard() {
  const rawVersion = useAccountsStore((s) => s.status?.version);
  const { version, buildTime, full } = friendlyVersion(rawVersion);
  const buildLabel = buildTime ? `构建 ${buildTime}` : "";
  const versionTitle = buildTime ? full : undefined;
  return (
    <section className="min-w-0 space-y-2.5" aria-labelledby="settings-about">
      <div className="px-1">
        <h2 id="settings-about" className="text-[13px] font-medium leading-5">关于</h2>
      </div>
      <Card className="min-w-0 gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <CardContent className="space-y-0 p-0">
          <div className="mx-4 flex min-w-0 items-center justify-between gap-3 border-b border-border/50 px-0 py-2.5 sm:mx-5">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-[13px] font-medium leading-4">xBuddy Switch</span>
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono" title={versionTitle}>
                  v{version || "?"}
                </Badge>
                {buildLabel && (
                  <span className="text-[10px] text-muted-foreground/75">{buildLabel}</span>
                )}
              </div>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground/75">
                更新源从{" "}
                <a
                  href={`https://github.com/${GITHUB_UPDATE_OWNER}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-foreground hover:opacity-80"
                >
                  @{GITHUB_UPDATE_OWNER}
                </a>{" "}
                提供的「
                <a
                  href={UPDATE_SOURCE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-foreground hover:opacity-80"
                >
                  {GITHUB_UPDATE_REPO}
                </a>
                」 获取
              </p>
            </div>
          </div>
          <div className="mx-4 flex min-w-0 items-center justify-between gap-3 border-b border-border/50 px-0 py-2.5 sm:mx-5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium leading-4">致谢</div>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground/75">
                <a
                  href={`https://github.com/${GITHUB_UPSTREAM_OWNER}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-blue-500/15 px-1 font-semibold text-blue-700 hover:bg-blue-500/25 dark:text-blue-400"
                >
                  @{GITHUB_UPSTREAM_OWNER}
                </a>{" "}
                开源项目「
                <a
                  href={GITHUB_UPSTREAM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-blue-500/15 px-1 font-semibold text-blue-700 hover:bg-blue-500/25 dark:text-blue-400"
                >
                  {GITHUB_UPSTREAM_REPO}
                </a>
                」
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
