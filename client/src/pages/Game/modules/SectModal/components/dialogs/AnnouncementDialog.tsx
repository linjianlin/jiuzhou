/**
 * 宗门公告编辑弹窗。
 * 输入：公告草稿与提交回调。
 * 输出：公告编辑 UI。
 * 边界：空字符串允许提交，表示清空公告。
 */
import { Input, Modal } from 'antd';

interface AnnouncementDialogProps {
  open: boolean;
  value: string;
  actionLoadingKey: string | null;
  onClose: () => void;
  onChange: (value: string) => void;
  onConfirm: () => void;
}

const ANNOUNCEMENT_MAX_LENGTH = 120;

const AnnouncementDialog: React.FC<AnnouncementDialogProps> = ({ open, value, actionLoadingKey, onClose, onChange, onConfirm }) => {
  // 与 TextArea 的 maxLength 保持同一套统计口径，避免计数显示与实际可输入长度不一致。
  const announcementLength = value.length;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      centered
      width={560}
      title="编辑宗门公告"
      className="sect-submodal"
      destroyOnHidden
      okText="保存"
      cancelText="取消"
      onOk={onConfirm}
      confirmLoading={actionLoadingKey === 'update-announcement'}
    >
      <div className="sect-form-field">
        <div className="sect-form-label">公告内容</div>
        <Input.TextArea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="请输入公告内容，留空后保存表示清空公告"
          autoSize={{ minRows: 4, maxRows: 8 }}
          maxLength={ANNOUNCEMENT_MAX_LENGTH}
        />
        <div className="sect-form-count">
          {announcementLength}/{ANNOUNCEMENT_MAX_LENGTH}
        </div>
      </div>
    </Modal>
  );
};

export default AnnouncementDialog;
