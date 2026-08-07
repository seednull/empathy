#include "common.h"

static void testDecodeU8(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_U8, 0xAB,
		EMPATHY_BYTECODE_OP_STORE, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.u8 == 0xAB);
}

static void testDecodeU16(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_U16, 0x34, 0x12,
		EMPATHY_BYTECODE_OP_STORE, 0x01, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.u16 == 0x1234);
}

static void testDecodeU32(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_U32, 0x78, 0x56, 0x34, 0x12,
		EMPATHY_BYTECODE_OP_STORE, 0x02, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.u32 == 0x12345678);
}

static void testDecodeU64(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_U64, 0xEF, 0xCD, 0xAB, 0x89, 0x67, 0x45, 0x23, 0x01,
		EMPATHY_BYTECODE_OP_STORE, 0x03, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.u64 == UINT64_C(0x0123456789ABCDEF));
}

static void testDecodeI8(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_I8, 0xFE,
		EMPATHY_BYTECODE_OP_STORE, 0x04, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.i8 == -2);
}

static void testDecodeI16(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_I16, 0x2E, 0xFB,
		EMPATHY_BYTECODE_OP_STORE, 0x05, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.i16 == -1234);
}

static void testDecodeI32(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_I32, 0xB2, 0x9E, 0x43, 0xFF,
		EMPATHY_BYTECODE_OP_STORE, 0x06, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.i32 == -12345678);
}

static void testDecodeI64(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_I64, 0xF8, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0xFE,
		EMPATHY_BYTECODE_OP_STORE, 0x07, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.i64 == -INT64_C(0x0102030405060708));
}

static void testDecodeF32(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_F32, 0x00, 0x00, 0x2A, 0x42,
		EMPATHY_BYTECODE_OP_STORE, 0x08, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.f32 == 42.5f);
}

static void testDecodeF64(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_F64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x2A, 0xC0,
		EMPATHY_BYTECODE_OP_STORE, 0x09, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.f64 == -13.25);
}

static void testDecodeAtom(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_ATOM, 0x07, 0x00, 0x00, 0x00, 0x2A, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_STORE, 0x0A, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Test_Values values = {0};
	testExecuteBytecode(context, payload, sizeof(payload), &values);
	TEST_CHECK(values.atom.type == 7 && values.atom.value == 42);
}

int main(void)
{
	Test_Context context = {0};
	testCreateContext(&context);

	testDecodeU8(&context);
	testDecodeU16(&context);
	testDecodeU32(&context);
	testDecodeU64(&context);
	testDecodeI8(&context);
	testDecodeI16(&context);
	testDecodeI32(&context);
	testDecodeI64(&context);
	testDecodeF32(&context);
	testDecodeF64(&context);
	testDecodeAtom(&context);

	testDestroyContext(&context);
	return 0;
}
