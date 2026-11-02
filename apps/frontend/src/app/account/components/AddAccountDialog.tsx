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
import { Info } from "lucide-react";
import { toast } from "sonner";
import { Qrcode115Panel } from "./Qrcode115Panel";

// 表单验证规则
export const accountFormSchema = z.object({
  accountType: z.string().min(1, "账户类型不能为空"),
  name: z.string().min(1, "账户名称不能为空"),
  // 115 / 夸克类型字段
  cookie: z.string().optional(),
  // openlist 类型字段
  account: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
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
};

export function AddAccountDialog({ account, trigger, onSuccess, open: openProp, onOpenChange }: AddAccountDialogProps) {
  const [openState, setOpenState] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const [loading, setLoading] = React.useState(false);

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: account ?? EMPTY_ACCOUNT,
  });

  const setOpen = (next: boolean) => {
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
  };

  // 每次打开都按当前的 account 重置：defaultValues 只在挂载时取一次，保存后重开会显示旧值
  const handleOpenChange = (next: boolean) => {
    if (next) form.reset(account ?? EMPTY_ACCOUNT);
    setOpen(next);
  };

  // 受控打开不经过 handleOpenChange（是父组件改的 open），这里补上同样的重置
  React.useEffect(() => {
    if (isControlled && openProp) form.reset(account ?? EMPTY_ACCOUNT);
  }, [isControlled, openProp, account, form]);

  const watchAccountType = form.watch("accountType");

  const onSubmit = async (values: AccountFormValues) => {
    setLoading(true);
    try {
      if (account) {
        // 编辑 → PUT
        await api.accounts.update(values);
        toast("账号更新成功");
      } else {
        // 新增 → POST
        await api.accounts.create(values);
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

      <DialogContent size="sm">
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
