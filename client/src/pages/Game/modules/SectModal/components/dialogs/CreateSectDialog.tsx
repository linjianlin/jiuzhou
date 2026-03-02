/**
 * 创建宗门弹窗。
 * 输入：名称/宣言草稿、灵石余额、提交回调。
 * 输出：创建确认 UI。
 * 约束：名称为空或灵石不足时禁止提交。
 */
import { Input, Modal, Tag } from 'antd';
import { IMG_COIN as coin01 } from '../../../../shared/imageAssets';

interface CreateSectDialogProps {
  open: boolean;
  createName: string;
  createNotice: string;
  spiritStones: number;
  createCost: number;
  canAffordCreate: boolean;
  actionLoadingKey: string | null;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onNoticeChange: (value: string) => void;
  onConfirm: () => void;
}

const CreateSectDialog: React.FC<CreateSectDialogProps> = ({
  open,
  createName,
  createNotice,
  spiritStones,
  createCost,
  canAffordCreate,
  actionLoadingKey,
  onClose,
  onNameChange,
  onNoticeChange,
  onConfirm,
}) => {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      centered
      width={560}
      title="创建宗门"
      className="sect-submodal"
      destroyOnHidden
      okText="确认创建"
      cancelText="取消"
      onOk={onConfirm}
      confirmLoading={actionLoadingKey === 'create'}
      okButtonProps={{ disabled: !createName.trim() || !canAffordCreate }}
    >
      <div className="sect-create">
        <div className="sect-create-cost">
          <img className="sect-create-cost-icon" src={coin01} alt="灵石" />
          <div className="sect-create-cost-text">创建消耗：{createCost.toLocaleString()} 灵石</div>
        </div>
        <div className="sect-create-balance">
          <div className="sect-create-balance-text">当前灵石：{spiritStones.toLocaleString()}</div>
          {!canAffordCreate ? <Tag color="red">灵石不足</Tag> : <Tag color="green">可创建</Tag>}
        </div>
        <div className="sect-form-field">
          <div className="sect-form-label">宗门名称</div>
          <Input value={createName} onChange={(event) => onNameChange(event.target.value)} placeholder="请输入宗门名称" maxLength={10} />
        </div>
        <div className="sect-form-field">
          <div className="sect-form-label">宗门宣言</div>
          <Input value={createNotice} onChange={(event) => onNoticeChange(event.target.value)} placeholder="一句话宗门宣言" maxLength={24} />
        </div>
      </div>
    </Modal>
  );
};

export default CreateSectDialog;
