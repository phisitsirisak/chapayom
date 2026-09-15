/* Client-only option lists — spice/sweetness levels, add-ons, quick notes,
 * table numbering. Everything the shop can edit (menu, categories, staff,
 * promos, expenses, orders) now lives in the backend; see backend/db.py.
 */
'use strict';

const SHOP_PHONE = '02-123-4567';

const SPICE = [
  { th: 'ไม่เผ็ด', en: 'Not spicy' }, { th: 'เผ็ดน้อย', en: 'Mild' },
  { th: 'เผ็ดกลาง', en: 'Medium' }, { th: 'เผ็ดมาก', en: 'Very spicy' }
];
const SWEET = [
  { th: 'ไม่หวาน', en: 'No sugar' }, { th: 'หวานน้อย', en: 'Less sweet' }, { th: 'หวานปกติ', en: 'Standard' }
];
const EX_FOOD = [
  { id: 'egg',  th: 'ไข่ดาว',            en: 'Fried egg',            p: 10 },
  { id: 'big',  th: 'พิเศษ เพิ่มปริมาณ', en: 'Extra large portion',  p: 15 },
  { id: 'rice', th: 'ข้าวเพิ่ม',         en: 'Extra rice',           p: 10 }
];
const EX_DRINK = [
  { id: 'noice', th: 'ไม่ใส่น้ำแข็ง',   en: 'No ice',             p: 0 },
  { id: 'jelly', th: 'เพิ่มเจลลี่',     en: 'Add jelly',          p: 10 }
];

const EXP_CATS = ['วัตถุดิบ', 'ค่าน้ำค่าไฟ', 'ค่าจ้าง', 'อุปกรณ์', 'อื่นๆ'];
const SEATS = { 1: 2, 2: 4, 3: 4, 4: 2, 5: 6, 6: 4 };
const TABLE_NOS = [1, 2, 3, 4, 5, 6];
