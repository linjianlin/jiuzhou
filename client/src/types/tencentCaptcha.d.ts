/**
 * 腾讯云天御验证码 TencentCaptcha 全局类型声明
 *
 * 天御 JS SDK 通过 <script> 标签动态加载后在 window 上注册 TencentCaptcha 类。
 * 本声明文件为 TypeScript 提供类型支持，避免在业务代码中使用 any。
 */

interface TencentCaptchaCallbackResult {
    /** 验证结果：0 验证成功，2 用户主动关闭 */
    ret: number;
    /** 验证成功的票据，ret === 0 时有值 */
    ticket: string | null;
    /** 验证码应用 ID */
    CaptchaAppId?: string;
    /** 自定义透传参数 */
    bizState?: string;
    /** 本次验证的随机串，后续票据校验时需传递 */
    randstr: string;
    /** 错误码 */
    errorCode?: number;
    /** 错误信息 */
    errorMessage?: string;
}

interface TencentCaptchaOptions {
    bizState?: string;
    enableDarkMode?: boolean | 'force';
    userLanguage?: string;
    loading?: boolean;
    needFeedBack?: boolean | string;
    type?: 'popup' | 'embed';
}

declare class TencentCaptcha {
    constructor(
        appId: string,
        callback: (result: TencentCaptchaCallbackResult) => void,
        options?: TencentCaptchaOptions,
    );
    show(): void;
    destroy(): void;
    getTicket(): { CaptchaAppId: string; ticket: string };
}
