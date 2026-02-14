/**
 * 入宗前的宗门大厅面板。
 * 输入：宗门列表、搜索关键字、加入状态与操作回调。
 * 输出：可检索/申请/创建宗门的 UI。
 * 边界：当玩家已有 pending 申请时，只允许继续查看，不允许对其他宗门重复申请。
 */
import { Button, Input, Table, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { JOIN_TYPE_LABEL_MAP } from '../constants';
import type { SectJoinState, SectListItemVm } from '../types';
import { useIsMobile } from '../../../shared/responsive';

interface NoSectHallPanelProps {
  listLoading: boolean;
  searchKeyword: string;
  onSearchKeywordChange: (value: string) => void;
  onSearch: () => void;
  onOpenCreate: () => void;
  sects: SectListItemVm[];
  joinState: SectJoinState;
  activeSectId: string;
  actionLoadingKey: string | null;
  onApplyJoin: (sectId: string) => void;
}

const NoSectHallPanel: React.FC<NoSectHallPanelProps> = ({
  listLoading,
  searchKeyword,
  onSearchKeywordChange,
  onSearch,
  onOpenCreate,
  sects,
  joinState,
  activeSectId,
  actionLoadingKey,
  onApplyJoin,
}) => {
  const isMobile = useIsMobile();

  const renderActionButton = (sectId: string) => {
    const isCurrent = activeSectId === sectId;
    const isPending = joinState === 'pending' && isCurrent;
    const disabled = (joinState === 'pending' && !isCurrent) || joinState === 'joined';
    return (
      <Button
        size="small"
        type={isPending ? 'default' : 'primary'}
        disabled={disabled}
        loading={actionLoadingKey === `apply-${sectId}`}
        onClick={() => {
          void onApplyJoin(sectId);
        }}
      >
        {isPending ? '已申请' : '申请加入'}
      </Button>
    );
  };

  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门大厅</div>
        </div>
        <div className="sect-pane-actions">
          <Button type="primary" onClick={onOpenCreate}>
            创建宗门
          </Button>
        </div>
      </div>

      <div className="sect-pane-body">
        <div className="sect-search-bar">
          <Input
            value={searchKeyword}
            onChange={(event) => onSearchKeywordChange(event.target.value)}
            onPressEnter={onSearch}
            placeholder="按宗门名称搜索"
            allowClear
            prefix={<SearchOutlined />}
          />
          <Button onClick={onSearch} loading={listLoading}>
            搜索
          </Button>
        </div>

        {isMobile ? (
          <div className="sect-mobile-list">
            {sects.length === 0 && !listLoading ? <div className="sect-empty">暂无符合条件的宗门</div> : null}
            {sects.map((row) => (
              <div key={row.id} className="sect-mobile-card">
                <div className="sect-mobile-card-head">
                  <div className="sect-mobile-card-title">{row.name}</div>
                  <Tag color="blue">Lv.{row.level}</Tag>
                </div>
                <div className="sect-mobile-meta-line">
                  <span className="sect-mobile-meta-item">
                    <span className="sect-mobile-meta-k">成员</span>
                    <span className="sect-mobile-meta-v">
                      {row.members}/{row.memberCap}
                    </span>
                  </span>
                  <span className="sect-mobile-meta-item">
                    <span className="sect-mobile-meta-k">加入方式</span>
                    <span className="sect-mobile-meta-v">{JOIN_TYPE_LABEL_MAP[row.joinType]}</span>
                  </span>
                  <span className="sect-mobile-meta-item">
                    <span className="sect-mobile-meta-k">最低境界</span>
                    <span className="sect-mobile-meta-v">{row.joinMinRealm}</span>
                  </span>
                </div>
                <div className="sect-mobile-message">{row.notice}</div>
                <div className="sect-mobile-actions">{renderActionButton(row.id)}</div>
              </div>
            ))}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            loading={listLoading}
            className="sect-table"
            columns={[
              { title: '宗门', dataIndex: 'name', key: 'name', width: 170 },
              {
                title: '等级',
                dataIndex: 'level',
                key: 'level',
                width: 90,
                render: (value: number) => `Lv.${value}`,
              },
              {
                title: '成员',
                key: 'members',
                width: 120,
                render: (_: unknown, row: SectListItemVm) => `${row.members}/${row.memberCap}`,
              },
              {
                title: '加入方式',
                dataIndex: 'joinType',
                key: 'joinType',
                width: 120,
                render: (value: SectListItemVm['joinType']) => JOIN_TYPE_LABEL_MAP[value],
              },
              { title: '最低境界', dataIndex: 'joinMinRealm', key: 'joinMinRealm', width: 100 },
              { title: '宣言', dataIndex: 'notice', key: 'notice' },
              {
                title: '操作',
                key: 'action',
                width: 140,
                render: (_: unknown, row: SectListItemVm) => renderActionButton(row.id),
              },
            ]}
            dataSource={sects}
            locale={{ emptyText: '暂无符合条件的宗门' }}
          />
        )}
      </div>
    </div>
  );
};

export default NoSectHallPanel;
