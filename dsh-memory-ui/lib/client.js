window.__ModuleLoader__.load({
	id: "dsh-memory-ui",
	factory: function(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
		let _deepseek_ai_dsh_client_locale = require("@deepseek-ai/dsh-client-locale");
		const { useState, useEffect, useCallback, useMemo, useRef } = react;

		const LAYERS = [
			{ id: 4, label: 'L4 深层', color: '#7c3aed' },
			{ id: 3, label: 'L3 整理', color: '#2563eb' },
			{ id: 2, label: 'L2 关键', color: '#16a34a' },
			{ id: 1, label: 'L1 原始', color: '#6b7280' },
		];
		const TRACKS = ['global', 'project', 'user', 'daily'];
		const TRACK_COLORS = {
			global: '#dc2626', project: '#2563eb', user: '#16a34a', daily: '#f59e0b',
		};
		const PAGE_SIZE = 50;

		// ============ API 调用层 ============
		const API = {
			async page({ offset, limit, sort, order, layers, tracks, tags, q }) {
				const p = new URLSearchParams();
				p.set('offset', String(offset || 0));
				p.set('limit', String(limit || PAGE_SIZE));
				p.set('sort', sort || 'created');
				p.set('order', order || 'desc');
				p.set('minPriority', '1');
				if (layers && layers.length) p.set('layers', layers.join(','));
				if (tracks && tracks.length) p.set('tracks', tracks.join(','));
				if (tags && tags.length) p.set('tags', tags.join(','));
				if (q) p.set('q', q);
				const r = await fetch('/api/memory/page?' + p.toString());
				if (!r.ok) throw new Error('page: ' + r.status);
				return r.json();
			},
			async stats() {
				const r = await fetch('/api/memory/stats');
				if (!r.ok) throw new Error('stats: ' + r.status);
				return r.json();
			},
			async add(content, opts) {
				const r = await fetch('/api/memory/add', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content, ...(opts || {}) }),
				});
				if (!r.ok) throw new Error('add: ' + r.status);
				return r.json();
			},
			async update(id, changes) {
				const r = await fetch('/api/memory/update', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, changes }),
				});
				if (!r.ok) throw new Error('update: ' + r.status);
				return r.json();
			},
			async remove(id, hard) {
				const r = await fetch('/api/memory/remove', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, hard: !!hard }),
				});
				if (!r.ok) throw new Error('remove: ' + r.status);
				return r.json();
			},
			async batch(op, payload) {
				const r = await fetch('/api/memory/batch', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ op, ...payload }),
				});
				if (!r.ok) throw new Error('batch: ' + r.status);
				return r.json();
			},
		};

		// ============ 工具函数 ============
		const fmtTime = (s) => {
			if (!s) return '';
			const d = new Date(String(s).replace(' ', 'T') + 'Z');
			if (isNaN(d.getTime())) return String(s);
			const now = new Date();
			const sameDay = d.toDateString() === now.toDateString();
			if (sameDay) return d.toTimeString().slice(0, 5);
			return d.toISOString().slice(0, 10);
		};
		const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');

		// ============ 主组件 ============
		function MemoryPanel({ memoryService, reload }) {
			const [rows, setRows] = useState([]);
			const [total, setTotal] = useState(0);
			const [page, setPage] = useState(0);
			const [sort, setSort] = useState('created');
			const [order, setOrder] = useState('desc');
			const [searchInput, setSearchInput] = useState('');
			const [searchQ, setSearchQ] = useState('');
			const [layerFilter, setLayerFilter] = useState([]);
			const [trackFilter, setTrackFilter] = useState([]);
			const [tagFilter, setTagFilter] = useState([]);
			const [stats, setStats] = useState({ total: 0, byLayer: [], byTrack: [], byPriority: [], topTags: [] });
			const [loading, setLoading] = useState(true);
			const [toast, setToast] = useState(null);
			const [selected, setSelected] = useState(new Set());
			const [editingId, setEditingId] = useState(null);
			const [editContent, setEditContent] = useState('');
			const [showAdd, setShowAdd] = useState(false);
			const [newContent, setNewContent] = useState('');
			const [newLayer, setNewLayer] = useState(3);
			const [newTrack, setNewTrack] = useState('user');
			const [newPriority, setNewPriority] = useState(3);
			const [confirmDel, setConfirmDel] = useState(null);
			const [hoverId, setHoverId] = useState(null);
			const searchTimer = useRef(null);

			const flash = useCallback((msg) => {
				setToast(msg);
				setTimeout(() => setToast(null), 2500);
			}, []);

			const loadPage = useCallback(async () => {
				try {
					setLoading(true);
					const r = await API.page({
						offset: page * PAGE_SIZE,
						limit: PAGE_SIZE,
						sort, order,
						layers: layerFilter, tracks: trackFilter, tags: tagFilter,
						q: searchQ,
					});
					setRows(r.rows || []);
					setTotal(r.total || 0);
					setSelected(new Set());
				} catch (e) {
					flash('加载失败: ' + e.message);
				} finally {
					setLoading(false);
				}
			}, [page, sort, order, layerFilter, trackFilter, tagFilter, searchQ, flash]);

			const loadStats = useCallback(async () => {
				try { setStats(await API.stats()); } catch {}
			}, []);

			const reloadAll = useCallback(async () => {
				await Promise.all([loadPage(), loadStats()]);
			}, [loadPage, loadStats]);

			useEffect(() => { reloadAll(); }, [reloadAll]);

			useEffect(() => {
				if (searchTimer.current) clearTimeout(searchTimer.current);
				searchTimer.current = setTimeout(() => {
					setSearchQ(searchInput);
					setPage(0);
				}, 300);
				return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
			}, [searchInput]);

			const onSort = (col) => {
				if (sort === col) setOrder(order === 'asc' ? 'desc' : 'asc');
				else { setSort(col); setOrder('desc'); }
				setPage(0);
			};

			const toggleFilter = (arr, setArr, val) => {
				setPage(0);
				if (arr.includes(val)) setArr(arr.filter(x => x !== val));
				else setArr([...arr, val]);
			};

			const toggleSelect = (id) => {
				const next = new Set(selected);
				if (next.has(id)) next.delete(id); else next.add(id);
				setSelected(next);
			};

			const toggleSelectAll = () => {
				if (rows.every(r => selected.has(r.id))) setSelected(new Set());
				else setSelected(new Set(rows.map(r => r.id)));
			};

			const handleAdd = async () => {
				if (!newContent.trim()) return;
				try {
					await API.add(newContent.trim(), { layer: newLayer, track: newTrack, priority: newPriority });
					setNewContent('');
					setShowAdd(false);
					flash('已添加');
					reloadAll();
				} catch (e) { flash('添加失败: ' + e.message); }
			};

			const handleEdit = async (id) => {
				if (!editContent.trim()) return;
				try {
					await API.update(id, { content: editContent.trim() });
					setEditingId(null);
					setEditContent('');
					flash('已更新');
					reloadAll();
				} catch (e) { flash('更新失败: ' + e.message); }
			};

			const handleDeleteOne = async (id, hard) => {
				try {
					await API.remove(id, hard);
					flash(hard ? '已物理删除' : '已软删除（priority=0）');
					reloadAll();
				} catch (e) { flash('删除失败: ' + e.message); }
			};

			const handleBatch = async (op, payload) => {
				const ids = [...selected];
				if (ids.length === 0) return;
				try {
					const r = await API.batch(op, { ids, ...payload });
					const n = r.updated ?? r.removed ?? 0;
					flash(`已处理 ${n} 条`);
					reloadAll();
				} catch (e) { flash('批量操作失败: ' + e.message); }
			};

			const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
			const allOnPageSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
			const someOnPageSelected = rows.some(r => selected.has(r.id));

			const layerPills = useMemo(() => {
				const map = new Map(stats.byLayer.map(x => [x.layer, x.n]));
				return LAYERS.map(l => ({ ...l, count: map.get(l.id) || 0 }));
			}, [stats]);
			const trackPills = useMemo(() => stats.byTrack.map(t => ({
				name: t.track, count: t.n, color: TRACK_COLORS[t.track] || '#6b7280',
			})), [stats]);
			const tagPills = useMemo(() => stats.topTags.slice(0, 12), [stats]);

			const sortIcon = (col) => sort === col ? (order === 'asc' ? ' ▲' : ' ▼') : '';

			return react_jsx_runtime.jsxs("div", { style: S.root, children: [
				toast && react_jsx_runtime.jsx("div", { style: S.toast, children: toast }),
				confirmDel && react_jsx_runtime.jsx("div", { style: S.confirmMask, children: react_jsx_runtime.jsxs("div", { style: S.confirmBox, children: [
					react_jsx_runtime.jsx("div", { style: S.confirmTitle, children: confirmDel.hard ? "确认物理删除？" : "确认软删除？" }),
					react_jsx_runtime.jsxs("div", { style: S.confirmBody, children: [
						react_jsx_runtime.jsxs("div", { children: ["将", confirmDel.hard ? "物理" : "软", "删除 ", react_jsx_runtime.jsx("b", { children: confirmDel.ids.length }), " 条记忆。"] }),
						confirmDel.hard && react_jsx_runtime.jsx("div", { style: { color: '#dc2626', fontSize: 12, marginTop: 4 }, children: "⚠ 物理删除不可恢复，连同向量索引一起清理。" }),
					] }),
					react_jsx_runtime.jsxs("div", { style: S.confirmActions, children: [
						react_jsx_runtime.jsx("button", { style: S.cancelBtn, onClick: () => setConfirmDel(null), children: "取消" }),
						react_jsx_runtime.jsx("button", {
							style: Object.assign({}, S.dangerBtn, { background: confirmDel.hard ? '#7f1d1d' : '#dc2626' }),
							onClick: async () => {
								const { ids, hard } = confirmDel;
								setConfirmDel(null);
								try {
									const r = await API.batch('remove', { ids, hard });
									flash(`已${hard ? '物理' : '软'}删除 ${r.removed} 条`);
									reloadAll();
								} catch (e) { flash('删除失败: ' + e.message); }
							},
							children: confirmDel.hard ? "硬删除" : "软删除",
						}),
					] }),
				] }) }),

				react_jsx_runtime.jsxs("div", { style: S.header, children: [
					react_jsx_runtime.jsxs("div", { style: S.titleRow, children: [
						react_jsx_runtime.jsx("span", { style: S.title, children: "🧠 记忆" }),
						react_jsx_runtime.jsxs("span", { style: S.badge, children: [total, " 条 · 第 ", page + 1, " / ", totalPages, " 页"] }),
					] }),
					react_jsx_runtime.jsxs("div", { style: S.statsRow, children: [
						...layerPills.map(l => react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.pill, {
								borderColor: l.color, color: l.color, background: layerFilter.includes(l.id) ? l.color + '22' : 'transparent',
							}),
							onClick: () => toggleFilter(layerFilter, setLayerFilter, l.id),
							title: `点击${layerFilter.includes(l.id) ? '取消' : '添加'} L${l.id} 过滤`,
							children: [l.label, " ", l.count],
						}, l.id)),
						...trackPills.map(t => react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.pill, {
								borderColor: t.color, color: t.color, background: trackFilter.includes(t.name) ? t.color + '22' : 'transparent',
							}),
							onClick: () => toggleFilter(trackFilter, setTrackFilter, t.name),
							title: `点击${trackFilter.includes(t.name) ? '取消' : '添加'} track 过滤`,
							children: [t.name, " ", t.count],
						}, t.name)),
					] }),
					tagPills.length > 0 && react_jsx_runtime.jsxs("div", { style: Object.assign({}, S.statsRow, { marginTop: 4 }), children: [
						react_jsx_runtime.jsx("span", { style: { fontSize: 11, color: '#9ca3af', marginRight: 4 }, children: "tags:" }),
						...tagPills.map(t => react_jsx_runtime.jsx("span", {
							style: Object.assign({}, S.pill, {
								borderColor: '#94a3b8', color: '#475569', background: tagFilter.includes(t.tag) ? '#94a3b822' : 'transparent',
							}),
							onClick: () => toggleFilter(tagFilter, setTagFilter, t.tag),
							children: ["#", t.tag, " ", t.count],
						}, t.tag)),
					] }),
				] }),

				react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
					react_jsx_runtime.jsx("input", {
						style: S.searchInput, placeholder: "搜索关键词...", value: searchInput,
						onChange: e => setSearchInput(e.target.value),
					}),
					(layerFilter.length > 0 || trackFilter.length > 0 || tagFilter.length > 0 || searchQ) && react_jsx_runtime.jsx("button", {
						style: S.iconBtn,
						onClick: () => { setLayerFilter([]); setTrackFilter([]); setTagFilter([]); setSearchInput(''); setPage(0); },
						children: "清空过滤",
					}),
					react_jsx_runtime.jsx("button", {
						style: Object.assign({}, S.addBtn, { background: '#2563eb' }),
						onClick: () => setShowAdd(!showAdd),
						children: showAdd ? "✕ 收起" : "+ 新增",
					}),
				] }),

				showAdd && react_jsx_runtime.jsxs("div", { style: S.formCard, children: [
					react_jsx_runtime.jsx("textarea", {
						style: S.textarea, placeholder: "输入记忆内容...", value: newContent,
						onChange: e => setNewContent(e.target.value), rows: 3,
					}),
					react_jsx_runtime.jsxs("div", { style: S.formRow, children: [
						react_jsx_runtime.jsxs("label", { style: S.formLabel, children: [
							"layer:", react_jsx_runtime.jsx("select", {
								style: S.select, value: newLayer,
								onChange: e => setNewLayer(Number(e.target.value)),
								children: LAYERS.map(l => react_jsx_runtime.jsx("option", { value: l.id, children: l.label }, l.id)),
							}),
						] }),
						react_jsx_runtime.jsxs("label", { style: S.formLabel, children: [
							"track:", react_jsx_runtime.jsx("select", {
								style: S.select, value: newTrack,
								onChange: e => setNewTrack(e.target.value),
								children: TRACKS.map(t => react_jsx_runtime.jsx("option", { value: t, children: t }, t)),
							}),
						] }),
						react_jsx_runtime.jsxs("label", { style: S.formLabel, children: [
							"p:", react_jsx_runtime.jsx("select", {
								style: S.select, value: newPriority,
								onChange: e => setNewPriority(Number(e.target.value)),
								children: [1, 2, 3, 4, 5].map(p => react_jsx_runtime.jsx("option", { value: p, children: String(p) }, p)),
							}),
						] }),
						react_jsx_runtime.jsx("button", { style: S.saveBtn, onClick: handleAdd, children: "保存" }),
					] }),
				] }),

				selected.size > 0 && react_jsx_runtime.jsxs("div", { style: S.batchBar, children: [
					react_jsx_runtime.jsx("span", { style: { fontWeight: 600 }, children: `已选 ${selected.size} 条` }),
					react_jsx_runtime.jsx("span", { style: { color: '#9ca3af', fontSize: 12, marginRight: 8 }, children: "→" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { layer: 4 } }), children: "→ L4" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { layer: 3 } }), children: "→ L3" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { track: 'user' } }), children: "→ user" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { track: 'project' } }), children: "→ project" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { priority: 5 } }), children: "→ p5" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => handleBatch('update', { changes: { priority: 1 } }), children: "→ p1" }),
					react_jsx_runtime.jsx("button", { style: S.miniBtn, onClick: () => {
						const t = prompt('要添加的 tag（不含 #）：');
						if (t?.trim()) handleBatch('tag', { add: [t.trim()] });
					}, children: "+ tag" }),
					react_jsx_runtime.jsx("button", { style: Object.assign({}, S.miniBtn, { color: '#dc2626', borderColor: '#fecaca' }), onClick: () => setConfirmDel({ ids: [...selected], hard: false }), children: "软删除" }),
					react_jsx_runtime.jsx("button", { style: Object.assign({}, S.miniBtn, { color: '#fff', background: '#7f1d1d', borderColor: '#7f1d1d' }), onClick: () => setConfirmDel({ ids: [...selected], hard: true }), children: "硬删除" }),
					react_jsx_runtime.jsx("button", { style: Object.assign({}, S.miniBtn, { marginLeft: 'auto' }), onClick: () => setSelected(new Set()), children: "清空选择" }),
				] }),

				react_jsx_runtime.jsx("div", { style: S.tableWrap, children: loading
					? react_jsx_runtime.jsx("div", { style: S.empty, children: "加载中..." })
					: rows.length === 0
						? react_jsx_runtime.jsx("div", { style: S.empty, children: "暂无记忆" })
						: react_jsx_runtime.jsx("table", { style: S.table, children: [
							react_jsx_runtime.jsx("thead", { children: react_jsx_runtime.jsxs("tr", { style: S.theadTr, children: [
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, { width: 28 }), children: react_jsx_runtime.jsx("input", {
									type: "checkbox", checked: allOnPageSelected,
									ref: el => { if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected; },
									onChange: toggleSelectAll,
								}) }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 44 }), onClick: () => onSort('id'), children: ["id", sortIcon('id')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 28 }), onClick: () => onSort('layer'), children: ["L", sortIcon('layer')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 64 }), onClick: () => onSort('track'), children: ["track", sortIcon('track')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 28 }), onClick: () => onSort('priority'), children: ["p", sortIcon('priority')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, { width: 100 }), children: "tags" }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { minWidth: 360 }), onClick: () => onSort('content'), children: ["content", sortIcon('content')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, S.thSort, { width: 78 }), onClick: () => onSort('created'), children: ["created", sortIcon('created')] }),
								react_jsx_runtime.jsx("th", { style: Object.assign({}, S.th, { width: 92 }), children: "操作" }),
							] }) }),
							react_jsx_runtime.jsx("tbody", { children: rows.map(m => {
								const lc = (LAYERS.find(l => l.id === m.layer) || LAYERS[3]).color;
								const tc = TRACK_COLORS[m.track] || '#6b7280';
								const isEditing = editingId === m.id;
								const isSelected = selected.has(m.id);
								const isHover = hoverId === m.id;
								const trStyle = isSelected ? S.trSelected : (isHover ? S.trHover : S.tr);
								return react_jsx_runtime.jsxs("tr", {
									style: trStyle,
									onMouseEnter: () => setHoverId(m.id),
									onMouseLeave: () => setHoverId(prev => prev === m.id ? null : prev),
									children: [
										react_jsx_runtime.jsx("td", { style: S.td, children: react_jsx_runtime.jsx("input", {
											type: "checkbox", checked: selected.has(m.id),
											onChange: () => toggleSelect(m.id),
										}) }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.tdMono, S.td), children: m.id }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.td, { color: lc, fontWeight: 600 }), children: m.layer }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.td, { color: tc, fontWeight: 600 }), children: m.track }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.tdMono, S.td), children: m.priority }),
										react_jsx_runtime.jsx("td", { style: S.td, children: (m.tags || []).slice(0, 3).map(t => react_jsx_runtime.jsx("span", {
											style: S.tagChip, children: ["#", t],
										}, t)) }),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.td, { wordBreak: 'break-word' }), children:
											isEditing
												? react_jsx_runtime.jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
													react_jsx_runtime.jsx("textarea", {
														style: S.editArea, value: editContent,
														onChange: e => setEditContent(e.target.value), rows: 2,
													}),
													react_jsx_runtime.jsxs("div", { style: { display: 'flex', gap: 4 }, children: [
														react_jsx_runtime.jsx("button", { style: S.saveBtn, onClick: () => handleEdit(m.id), children: "✓" }),
														react_jsx_runtime.jsx("button", { style: S.cancelBtn, onClick: () => { setEditingId(null); setEditContent(''); }, children: "✕" }),
													] }),
												] })
												: react_jsx_runtime.jsx("span", { style: S.contentCell, title: m.content, children: truncate(m.content, 240) })
										}),
										react_jsx_runtime.jsx("td", { style: Object.assign({}, S.tdMono, S.td), title: m.created, children: fmtTime(m.created) }),
										react_jsx_runtime.jsxs("td", { style: S.td, children: [
											!isEditing && react_jsx_runtime.jsx("button", { style: S.rowBtn, onClick: () => { setEditingId(m.id); setEditContent(m.content); }, children: "✎" }),
											' ',
											react_jsx_runtime.jsx("button", { style: Object.assign({}, S.rowBtn, { color: '#dc2626' }), onClick: () => handleDeleteOne(m.id, false), title: "软删除", children: "🗑" }),
											' ',
											react_jsx_runtime.jsx("button", { style: Object.assign({}, S.rowBtn, { color: '#7f1d1d' }), onClick: () => handleDeleteOne(m.id, true), title: "硬删除", children: "🔥" }),
										] }),
									],
								}, m.id);
							}) }),
						] })
				}),

				totalPages > 1 && react_jsx_runtime.jsxs("div", { style: S.pager, children: [
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page === 0, onClick: () => setPage(0), children: "« 首页" }),
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page === 0, onClick: () => setPage(p => Math.max(0, p - 1)), children: "‹ 上一页" }),
					react_jsx_runtime.jsxs("span", { style: { padding: '0 8px' }, children: ["第 ", react_jsx_runtime.jsx("input", {
						style: S.pageInput, type: "number", min: 1, max: totalPages, value: page + 1,
						onChange: e => {
							const v = parseInt(e.target.value) || 1;
							setPage(Math.max(0, Math.min(totalPages - 1, v - 1)));
						},
					}), " / ", totalPages, " 页"] }),
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page >= totalPages - 1, onClick: () => setPage(p => Math.min(totalPages - 1, p + 1)), children: "下一页 ›" }),
					react_jsx_runtime.jsx("button", { style: S.pageBtn, disabled: page >= totalPages - 1, onClick: () => setPage(totalPages - 1), children: "尾页 »" }),
					react_jsx_runtime.jsxs("span", { style: { marginLeft: 'auto', fontSize: 12, color: '#6b7280' }, children: ["共 ", total, " 条，每页 ", PAGE_SIZE] }),
				] }),
			] });
		}

		// ============ 样式 ============
		const S = {
			root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--dsw-alias-bg-base,#fff)', color: 'var(--dsw-alias-label-primary,#111)' },
			toast: { position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#111', color: '#fff', padding: '8px 20px', borderRadius: 8, fontSize: 13, zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
			confirmMask: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 },
			confirmBox: { background: '#fff', borderRadius: 10, padding: 20, minWidth: 320, maxWidth: 480, boxShadow: '0 8px 32px rgba(0,0,0,0.3)' },
			confirmTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12 },
			confirmBody: { fontSize: 13, lineHeight: 1.6, marginBottom: 16 },
			confirmActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
			header: { padding: '12px 16px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex: 'none' },
			titleRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
			title: { fontSize: 16, fontWeight: 600 },
			badge: { background: '#eff6ff', color: '#2563eb', borderRadius: 12, padding: '2px 8px', fontSize: 12, fontWeight: 500 },
			statsRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
			pill: { fontSize: 11, padding: '2px 10px', borderRadius: 12, cursor: 'pointer', border: '1px solid', fontWeight: 500, userSelect: 'none' },
			toolbar: { display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex: 'none', alignItems: 'center' },
			searchInput: { flex: 1, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', fontSize: 13, background: 'var(--dsw-alias-bg-layer-1,#f9fafb)' },
			iconBtn: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'transparent', cursor: 'pointer', fontSize: 12, color: '#6b7280' },
			addBtn: { padding: '6px 14px', borderRadius: 8, border: 'none', fontSize: 13, cursor: 'pointer', color: '#fff', fontWeight: 500 },
			formCard: { padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex: 'none', background: 'var(--dsw-alias-bg-layer-1,#f9fafb)' },
			formRow: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
			formLabel: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: '#6b7280' },
			textarea: { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', fontSize: 13, resize: 'vertical', background: 'var(--dsw-alias-bg-base,#fff)', fontFamily: 'inherit', boxSizing: 'border-box' },
			editArea: { width: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #93c5fd', fontSize: 12, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' },
			select: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', fontSize: 12, background: 'var(--dsw-alias-bg-base,#fff)' },
			saveBtn: { padding: '4px 12px', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 500 },
			cancelBtn: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'transparent', fontSize: 12, cursor: 'pointer' },
			dangerBtn: { padding: '6px 14px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 500 },
			batchBar: { display: 'flex', gap: 6, padding: '8px 16px', background: '#eff6ff', borderBottom: '1px solid #bfdbfe', flex: 'none', alignItems: 'center', flexWrap: 'wrap' },
			miniBtn: { padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: '#fff', fontSize: 11, cursor: 'pointer', color: '#374151' },
			tableWrap: { flex: 1, overflow: 'auto', padding: '0' },
			empty: { textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '40px 0' },
			table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.45, tableLayout: 'auto' },
			theadTr: { position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-layer-1,#f9fafb)', zIndex: 1 },
			th: { textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1,#e5e7eb)', fontWeight: 600, color: '#475569', whiteSpace: 'nowrap', fontSize: 11, letterSpacing: 0.2, textTransform: 'uppercase', background: 'var(--dsw-alias-bg-layer-1,#f9fafb)' },
			thSort: { cursor: 'pointer', userSelect: 'none' },
			tr: { borderBottom: '1px solid #f1f5f9' },
			trHover: { background: '#f8fafc', borderBottom: '1px solid #e2e8f0' },
			trSelected: { background: '#eff6ff', borderBottom: '1px solid #bfdbfe' },
			td: { padding: '4px 8px', verticalAlign: 'middle', color: '#1e293b', height: 28, lineHeight: '20px' },
			tdMono: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: '#64748b' },
			contentCell: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' },
			tagChip: { display: 'inline-block', background: '#e0e7ff', color: '#4338ca', padding: '0 5px', borderRadius: 6, fontSize: 10, marginRight: 2, lineHeight: '16px' },
			rowBtn: { padding: '1px 6px', borderRadius: 3, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'transparent', cursor: 'pointer', color: '#374151', fontSize: 11, lineHeight: '16px' },
			pager: { display: 'flex', gap: 4, padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l1,#e5e7eb)', flex: 'none', alignItems: 'center', fontSize: 12, background: 'var(--dsw-alias-bg-base,#fff)' },
			pageBtn: { padding: '3px 10px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'var(--dsw-alias-bg-base,#fff)', fontSize: 11, cursor: 'pointer' },
			pageInput: { width: 48, padding: '2px 4px', borderRadius: 3, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', textAlign: 'center', fontSize: 11 },
		};

		const NS = 'memory-ui';
		const inject = ['slots', 'locale'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { 'view.memory': '记忆' },
				en: { 'view.memory': 'Memory' },
			}), 'memory-ui: locale');

			const t = ctx.locale.bind(NS);

			ctx.effect(() => {
				ctx.slots.inject('conversation.view', () => ctx.slots.register({
					name: 'conversation.view',
					id: 'memory',
					order: 15,
					locale: NS,
					label: () => t('view.memory'),
					inject: (_sessionId) => ({ reload: () => {} }),
				}, MemoryPanel));
			}, 'memory-ui: slot');
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
