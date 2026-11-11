"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useForm } from "react-hook-form";

import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Qrcode115Panel } from "./Qrcode115Panel";

/** CloudDrive2 的地址：协议可省，host[:端口]，后面不带路径（和后端 services/drive/credentials.ts 一样） */
const CD2_URL = /^(https?:\/\/)?[^\s/]+(:\d+)?\/?$/i;

// 表单验证规则
export const accountFormSchema = z.object({
  accountType: z.string().min(1, "账户类型不能为空"),
  name: z.string().min(1, "账户名称不能为空"),
  // 115 / 夸克类型字段
  cookie: z.string().optional(),
  // openlist 类型字段
  account: z.string().optional(),
  // openlist 的密码、CloudDrive2 的口令
  password: z.string().optional(),
  // openlist / CloudDrive2 的地址
  url: z.string().optional(),
  // CloudDrive2 类型字段：API 令牌，或者用户名 + 口令
  apiToken: z.string().optional(),
  username: z.string().optional(),
}).refine((data) => {
  if (data.accountType === "115" || data.accountType === "quark") {
    return data.cookie && data.cookie.length > 0;
  } else if (data.accountType === "openlist") {
    return data.account && data.password && data.url;
  }
  return true;
}, {
  message: "请填写对应账户类型的必需字段",
  path: ["accountType"]
}).superRefine((data, ctx) => {
  // CloudDrive2 缺什么标在哪一栏上：两组凭据二选一，光一句「请填写必需字段」看不出缺的是哪个
  if (data.accountType !== "cd2") return;
  const url = (data.url ?? "").trim();
  if (!url) ctx.addIssue({ code: "custom", path: ["url"], message: "填 CloudDrive2 的地址，比如 http://192.168.1.10:19798" });
  else if (!CD2_URL.test(url)) ctx.addIssue({ code: "custom", path: ["url"], message: "地址只要协议、主机和端口，比如 http://192.168.1.10:19798" });
  if (!data.apiToken && !((data.username ?? "").trim() && data.password)) {
    ctx.addIssue({ code: "custom", path: ["apiToken"], message: "填 API 令牌，或者填下面的用户名和口令" });
  }
});

export type AccountFormValues = z.infer<typeof accountFormSchema>;

interface AddAccountDialogProps {
  account?: AccountFormValues; // 编辑模式
  trigger?: React.ReactNode;   // 自定义按钮
  onSuccess?: () => void;      // 新增/编辑成功后的回调
  /** 受控模式：页面统一管一个编辑弹框时传入 open / onOpenChange；不传则自己管 open（"新增账户"按钮那种用法） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const EMPTY_ACCOUNT: AccountFormValues = {
  accountType: "",
  name: "",
  cookie: "",
  account: "",
  password: "",
  url: "",
  apiToken: "",
  username: "",
};

/** 表单的初值：编辑时也把没存过的字段补成空串（CD2 账号只有令牌时没有 username），输入框才不会从「不受控」变「受控」 */
const initialValues = (account?: AccountFormValues): AccountFormValues => (account ? { ...EMPTY_ACCOUNT, ...account } : EMPTY_ACCOUNT);

/** 每种账号交哪几栏：别的类型的栏不带上去，免得往账号里存一堆空键（password / url 是 OpenList 和 CloudDrive2 共用的） */
const TYPE_FIELDS: Record<string, Array<keyof AccountFormValues>> = {
  "115": ["cookie"],
  quark: ["cookie"],
  openlist: ["account", "password", "url"],
  cd2: ["url", "apiToken", "username", "password"],
};

export function AddAccountDialog({ account, trigger, onSuccess, open: openProp, onOpenChange }: AddAccountDialogProps) {
  const [openState, setOpenState] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const [loading, setLoading] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: initialValues(account),
  });

  const setOpen = (next: boolean) => {
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
  };

  // 每次打开都按当前的 account 重置：defaultValues 只在挂载时取一次，保存后重开会显示旧值
  const handleOpenChange = (next: boolean) => {
    if (next) form.reset(initialValues(account));
    setOpen(next);
  };

  // 受控打开不经过 handleOpenChange（是父组件改的 open），这里补上同样的重置
  React.useEffect(() => {
    if (isControlled && openProp) form.reset(initialValues(account));
  }, [isControlled, openProp, account, form]);

  const watchAccountType = form.watch("accountType");

  /**
   * CloudDrive2 的「检查连接」：按表单里现在填的值连一次（不用先保存）。
   * 令牌 / 口令还是掩码的，后端按正在编辑的这个账号换回存着的原值
   */
  const checkCd2 = async () => {
    const v = form.getValues();
    setChecking(true);
    try {
      const r = await api.cd2.check({
        ...(account?.name ? { account: account.name } : {}),
        url: (v.url ?? "").trim(),
        apiToken: v.apiToken ?? "",
        username: v.username ?? "",
        password: v.password ?? "",
      });
      const lines = [
        `${r.system.ok ? "✓" : "✗"} 地址：${r.system.message}`,
        `${r.auth.ok ? "✓" : "✗"} 凭据：${r.auth.message}`,
        // 读得到令牌的权限表就按用途说（CD2 只给带「令牌管理」权限的令牌读）；读不到才列「获取传输任务」那一下探测
        ...(r.permissions ? [`${r.permissions.ok ? "✓" : "✗"} 权限：${r.permissions.message}`] : r.copy ? [`${r.copy.ok ? "✓" : "✗"} 复制：${r.copy.message}`] : []),
      ];
      // 权限不全不算连不上：只同步的人本来就不用勾整理、复制那几项
      if (r.system.ok && r.auth.ok) toast.success(lines.join("；"));
      else toast.error(lines.join("；"));
    } catch (err) {
      toast.error(apiErrorMessage(err, "检查失败"));
    } finally {
      setChecking(false);
    }
  };

  const onSubmit = async (values: AccountFormValues) => {
    setLoading(true);
    try {
      const payload: Record<string, unknown> & { name: string } = { accountType: values.accountType, name: values.name };
      for (const field of TYPE_FIELDS[values.accountType] ?? []) payload[field] = values[field] ?? "";
      if (account) {
        // 编辑 → PUT
        await api.accounts.update(payload);
        toast("账号更新成功");
      } else {
        // 新增 → POST
        await api.accounts.create(payload);
        toast("账号添加成功");
      }

      // 调用回调刷新列表
      onSuccess?.();

      setOpen(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, "操作失败"));
    } finally {
      setLoading(false);
    }
  };

  /** 下拉里显示的名字；值不变，后端和任务表都认这些值 */
  const accountTypes: Array<{ value: string; label: string }> = [
    { value: "115", label: "115 网盘" },
    { value: "openlist", label: "OpenList" },
    { value: "quark", label: "夸克网盘" },
    { value: "cd2", label: "CloudDrive2" },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {(trigger !== undefined || !isControlled) && (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button variant="outline">{account ? "Edit Account" : "Add Account"}</Button>
          )}
        </DialogTrigger>
      )}

      {/* CloudDrive2 那一套字段加上校验提示比矮屏幕高：和任务弹框一样限高、里面滚 */}
      <DialogContent size="sm" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? "编辑账户" : "新增账户"}</DialogTitle>
          <DialogDescription>
            {account ? "编辑你的账户信息" : "添加一个新的网盘账户"}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 账号类型 */}
            <FormField
              control={form.control}
              name="accountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户类型</FormLabel>
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择账户类型" />
                      </SelectTrigger>
                      <SelectContent>
                        {accountTypes.map(({ value, label }) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 账户名称 */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>账户名称</FormLabel>
                  <FormControl>
                    <Input placeholder="输入账户名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 115 类型字段 */}
            {watchAccountType === "115" && (
              <>
                <FormField
                  control={form.control}
                  name="cookie"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cookie</FormLabel>
                      <FormControl>
                        <SecretInput
                          placeholder="填 115 App 端的 Cookie，或用下面的扫码登录"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={account?.cookie}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* 扫码拿到的 cookie 填进上面的字段，仍由用户点保存 */}
                <Qrcode115Panel
                  hasSaved={Boolean(account?.cookie)}
                  onCookie={(cookie) => form.setValue("cookie", cookie, { shouldDirty: true, shouldValidate: true })}
                />
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    如果希望使用 302 重定向功能，推荐将账户名称与 openlist、cd2 的 115 账户用户名保持一致，这样可以保证正确回源。
                  </AlertDescription>
                </Alert>
              </>
            )}

            {/* 夸克类型字段：和 115 一样只要 cookie */}
            {watchAccountType === "quark" && (
              <>
                <FormField
                  control={form.control}
                  name="cookie"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cookie</FormLabel>
                      <FormControl>
                        <SecretInput
                          placeholder="输入夸克网盘的 Cookie"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={account?.cookie}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    浏览器登录 pan.quark.cn 后，在开发者工具的网络面板里找任意 drive-pc.quark.cn 的请求，复制请求头里的
                    Cookie。夸克的直链取文件必须带 Cookie，所以夸克任务不支持 302，strm 里只写路径前缀。
                  </AlertDescription>
                </Alert>
              </>
            )}

            {/* openlist 类型字段 */}
            {watchAccountType === "openlist" && (
              <>
                <FormField
                  control={form.control}
                  name="account"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input placeholder="输入用户名" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>密码</FormLabel>
                      <FormControl>
                        <SecretInput
                          placeholder="输入密码"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={account?.password}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>服务器地址</FormLabel>
                      <FormControl>
                        <Input placeholder="输入服务器地址，如: https://example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* CloudDrive2 类型字段：地址 + API 令牌，或地址 + 用户名口令 */}
            {watchAccountType === "cd2" && (
              <>
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>CD2 地址</FormLabel>
                      <FormControl>
                        <Input placeholder="http://192.168.1.10:19798" {...field} />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">和 CD2 网页同一个端口，默认 19798</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="apiToken"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API 令牌</FormLabel>
                      <FormControl>
                        <SecretInput
                          placeholder="CD2 设置里「API 令牌」生成的那一串"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={account?.apiToken}
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">推荐。填了令牌就不用下面的用户名和口令；开了两步验证的 CD2 账号只能用令牌</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>用户名</FormLabel>
                      <FormControl>
                        <Input placeholder="登录 CD2 的账号，没有令牌时填" autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>口令</FormLabel>
                      <FormControl>
                        <SecretInput
                          placeholder="没有令牌时和用户名一起填"
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          masked={account?.password}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    令牌的权限按用途勾：浏览和刷新目录要「列出文件」；同步再加「读取文件」；整理再加「创建文件夹」「重命名」「移动」「删除」；
                    当复制引擎要「复制」「获取传输任务」「创建文件夹」。少勾了的，用到时报错里会写缺哪一项。同步任务的远程路径填 CD2 里的路径，比如 /115/电影。
                  </AlertDescription>
                </Alert>
                <Button type="button" variant="outline" size="sm" disabled={checking || !(form.watch("url") ?? "").trim()} onClick={() => void checkCd2()}>
                  {checking ? <Loader2 className="size-4 animate-spin" /> : null}
                  检查连接
                </Button>
              </>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={loading}>
                  取消
                </Button>
              </DialogClose>
              <Button type="submit" disabled={loading}>
                {loading ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
