#include "common.h"

static void testUnknownOpcode(Test_Context *context)
{
	const uint8_t payload[] = {0x31};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_OPCODE);
}

static void testTruncatedInstruction(Test_Context *context)
{
	const uint8_t payload[] = {EMPATHY_BYTECODE_OP_PUSH_U32, 0x00};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_OPCODE);
}

static void testJumpTargetInOperand(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_JUMP, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

static void testInvalidParameterIndex(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_LOAD, 0x0B, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

static void testInvalidYieldIndex(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_YIELD, 0x01, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

static void testInvalidAtom(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_ATOM, 0x07, 0x00, 0x00, 0x00, 0x65, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

int main(void)
{
	Test_Context context = {0};
	testCreateContext(&context);

	testUnknownOpcode(&context);
	testTruncatedInstruction(&context);
	testJumpTargetInOperand(&context);
	testInvalidParameterIndex(&context);
	testInvalidYieldIndex(&context);
	testInvalidAtom(&context);

	testDestroyContext(&context);
	return 0;
}
