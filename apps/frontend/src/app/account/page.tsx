"use client";
import { DataTable } from "@/components/data-table";
import { AddAccountDialog } from "./components/AddAccountDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading";
import { ColumnDef } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type DriveKind } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { DRIVE_FULL_LABEL } from "@/lib/drive";
import { Edit, Trash2, Plus, User, Key, KeyRound } from "lucide-react";

export type Account = {
  accountType: string;
  name: string;
  cookie?: string;      // 115 / 夸克类型使用
  account?: string;     // openlist 类型使用 (用户名)
  password?: string;    // openlist 的密码、CloudDrive2 的口令
  url?: string;         // openlist / CloudDrive2 的地址
  token?: string;       // openlist 类型的认证令牌
  expiresAt?: number;   // openlist 类型的令牌过期时间
  apiToken?: string;    // CloudDrive2 的 API 令牌（回来的是掩码）
  username?: string;    // CloudDrive2 没有令牌时的用户名
};

/** 类型徽标上的叫法：认得的用中文全称，认不出的原样给 */
const typeLabel = (accountType: string): string => DRIVE_FULL_LABEL[accountType as DriveKind] ?? accountType;

/** 认证信息：表格列和手机卡片共用。手机上没法 hover 看 title，wrap 时 cookie 直接换行显示 */
function Credentials({ account, wrap = false }: { account: Account; wrap?: boolean }) {
  if (account.accountType === "115" || account.accountType === "quark") {
    const cookie = account.cookie ?? "";
    const shortCookie = cookie.length > 30 ? cookie.slice(0, 30) + "..." : cookie;

    return (
      <div className="flex items-center gap-2">
        <Key className="size-4 shrink-0 text-muted-foreground" />
        <code
          title={cookie}
          className={`block rounded bg-muted px-2 py-1 font-mono text-xs ${wrap ? "break-all" : "max-w-xs truncate"}`}
        >
          {shortCookie}
        </code>
      </div>
    );
  }
  if (account.accountType === "openlist") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <User className="size-3 text-muted-foreground" />
          <span className="text-muted-foreground">用户:</span>
          <code className="rounded bg-muted px-1 font-mono">{account.account}</code>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Key className="size-3 text-muted-foreground" />
          <span className="text-muted-foreground">密码:</span>
          <code className="rounded bg-muted px-1 font-mono">
            {"*".repeat(Math.min(account.password?.length ?? 0, 8))}
          </code>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">URL:</span>
          <code className={`rounded bg-muted px-1 font-mono text-brand ${wrap ? "break-all" : ""}`}>
            {account.url}
          </code>
        </div>
      </div>
    );
  }
  if (account.accountType === "cd2") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">地址:</span>
          <code className={`rounded bg-muted px-1 font-mono text-brand ${wrap ? "break-all" : ""}`}>{account.url}</code>
        </div>
        {account.apiToken ? (
          <div className="flex items-center gap-2 text-xs">
            <Key className="size-3 text-muted-foreground" />
            <span className="text-muted-foreground">API 令牌:</span>
            <code className="rounded bg-muted px-1 font-mono">{account.apiToken}</code>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            <User className="size-3 text-muted-foreground" />
            <span className="text-muted-foreground">用户:</span>
            <code className="rounded bg-muted px-1 font-mono">{account.username || "-"}</code>
          </div>
        )}
      </div>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

export default function AccountPage() {
  const [data, setData] = useState<Account[]>([]);
  // 只有首次加载显示骨架；之后的刷新列表留在屏幕上
  const [loaded, setLoaded] = useState(false);
  // 编辑 / 删除弹框放在页面层，由当前操作的那一行驱动，不在每一行里各放一份
  const [editing, setEditing] = useState<Account | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      setData(await api.accounts.list());
    } catch (err) {
      toast.error(apiErrorMessage(err, "获取账户列表失败"));
    } finally {
      setLoaded(true);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await api.accounts.remove(name);
      toast.success("删除成功");
      fetchAccounts();
    } catch (err) {
      toast.error(apiErrorMessage(err, "删除失败"));
    }
  };

  /** 表格和手机卡片的「编辑」都走这里：喂上那一行的数据再打开页面级的弹框 */
  const openEditor = (account: Account) => {
    setEditing(account);
    setEditorOpen(true);
  };

  const columns: ColumnDef<Account>[] = [
    {
      accessorKey: "name",
      header: "账户名称",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <User className="size-4 text-muted-foreground" />
          <span className="font-medium">{row.original.name}</span>
        </div>
      ),
    },
    {
      accessorKey: "accountType",
      header: "账户类型",
      cell: ({ row }) => (
        <Badge variant="outline" className="text-xs">
          {typeLabel(row.original.accountType)}
        </Badge>
      ),
    },
    {
      id: "credentials",
      header: "认证信息",
      cell: ({ row }) => <Credentials account={row.original} />,
    },
    {
      id: "actions",
      header: () => <div className="text-right">操作</div>,
      cell: ({ row }) => {
        const account = row.original;
        return (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="编辑账户"
              onClick={() => openEditor(account)}
            >
              <Edit className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:text-destructive"
              title="删除账户"
              onClick={() => setDeleteTarget(account)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  /** 新增和编辑共用页面底部那一个弹框：editing 为空就是新增 */
  const addButton = (
    <Button
      onClick={() => {
        setEditing(null);
        setEditorOpen(true);
      }}
    >
      <Plus className="size-4" />
      新增账户
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader icon={KeyRound} title="账户管理" description="管理你的网盘账户，以及 OpenList / CloudDrive2 这类挂载层的账户" actions={addButton} />

      {!loaded ? (
        <TableSkeleton rows={3} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="暂无账户"
          description="添加一个 115、夸克、OpenList 或 CloudDrive2 账号，同步任务、云下载和网盘监控都要用它"
          action={addButton}
        />
      ) : (
        <>
          {/* 手机上一账号一张卡：表格横向滚起来操作列就看不见了 */}
          <div className="space-y-3 md:hidden">
            {data.map((account) => (
              <div key={account.name} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <User className="size-4 shrink-0 text-muted-foreground" />
                    <span className="break-all text-sm font-medium">{account.name}</span>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {typeLabel(account.accountType)}
                  </Badge>
                </div>
                <div className="mt-3">
                  <Credentials account={account} wrap />
                </div>
                <div className="mt-3 flex items-center gap-2 border-t pt-3">
                  <Button variant="outline" size="sm" className="h-9 flex-1" onClick={() => openEditor(account)}>
                    <Edit className="size-4" />
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 text-destructive hover:text-destructive"
                    title="删除"
                    onClick={() => setDeleteTarget(account)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <DataTable columns={columns} data={data} getRowId={(a) => a.name} />
          </div>
        </>
      )}

      {/* 新增 / 编辑弹框：整页一个，编辑哪一行就喂哪一行的数据，新增时 account 为空 */}
      <AddAccountDialog
        account={editing ?? undefined}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSuccess={fetchAccounts}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              你确定要删除账户 &ldquo;{deleteTarget?.name}&rdquo; 吗？此操作无法撤销。
              <br />
              <span className="mt-2 block text-sm text-muted-foreground">
                账户类型: {deleteTarget ? typeLabel(deleteTarget.accountType) : ""}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget.name);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
